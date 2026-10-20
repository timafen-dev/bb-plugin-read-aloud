// bb-plugin-read-aloud — frontend.
//
// One ▶ on every message. Press it and the message is read; the same icon
// becomes ■ while it plays, and pressing it again stops. Starting a voice
// recording stops the reading too, the way it does in the Claude app.
//
// BB's messageAction registration carries a fixed icon, so the ▶/■ swap is done
// where the SDK says such things belong: a trusted content script that
// decorates the app shell's own DOM.
//
// `run` is a plain callback, not a React component, so useRpc is unavailable
// there. The RPC route is the documented, same-origin
// POST /api/v1/plugins/<id>/rpc/<method> — exactly what useRpc calls.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import { speakableText } from "./text.ts";
import { ReadingSession } from "./reading-session.ts";
import { mountPlayer, type PlayerView } from "./player-view.ts";
import { ChunkClient } from "./chunk-client.ts";
import type { ChunkAudio } from "./speech-jobs.ts";
import {
  activatePlayback,
  ChunkPlayback,
  decodePlayback,
  disposePlayback,
} from "./playback.ts";

const PLUGIN_ID = "read-aloud";
const RPC_URL = `/api/v1/plugins/${PLUGIN_ID}/rpc`;
const ACTION_TITLE = "Read aloud";
const PLAYING_ATTRIBUTE = "data-read-aloud-playing";

type AudioFormat = "opus" | "mp3" | "wav";

/**
 * Safari on iOS does not play ogg/opus. Ask the browser rather than sniffing
 * the user agent, and fall back to mp3, which every browser plays.
 */
function preferredFormat(): AudioFormat {
  const probe = document.createElement("audio");
  return probe.canPlayType('audio/ogg; codecs="opus"') !== "" ? "opus" : "mp3";
}

async function rpc<T>(
  method: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${RPC_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(signal ? [signal] : []),
    ]),
  });
  const payload: unknown = await response.json().catch(() => null);
  const asRecord =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!response.ok || asRecord.ok === false) {
    const error = asRecord.error as { message?: unknown } | undefined;
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : `Read aloud failed (HTTP ${response.status}).`,
    );
  }
  return ("result" in asRecord ? asRecord.result : payload) as T;
}

function audioBytes({ audioBase64 }: ChunkAudio): Uint8Array {
  return Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
}

/** The button the user actually pressed, so the ■ lands on the right message. */
let pressedButton: HTMLElement | null = null;

interface SessionRecord {
  key: string;
  session: ReadingSession;
  client: ChunkClient;
  view: PlayerView | null;
  button: HTMLElement | null;
  anchor: HTMLElement | null;
  rowId: string | null;
  columnIndex: number;
  wantedPanel: boolean;
  unsubscribe: () => void;
}
const sessions = new Map<string, SessionRecord>();
let active: SessionRecord | null = null;
let actionGeneration = 0;
let pressedAt = 0;

function stopReading(): void {
  active?.session.pause();
}
function focusRecord(record: SessionRecord): void {
  activatePlayback();
  if (active !== record) active?.session.pause();
  active = record;
}
function disposeRecord(record: SessionRecord): void {
  record.unsubscribe();
  record.view?.dispose();
  record.client.dispose();
  record.session.dispose();
  record.button?.removeAttribute(PLAYING_ATTRIBUTE);
}
function anchorFromColumn(column: HTMLElement | null): HTMLElement | null {
  return (
    column?.querySelector<HTMLElement>(":scope > .relative.w-full") ?? null
  );
}
function findAnchor(text: string): HTMLElement | null {
  if (pressedButton?.isConnected && Date.now() - pressedAt < 2000) {
    const slot = pressedButton.parentElement?.parentElement;
    if (slot?.classList.contains("relative")) return slot;
  }
  const selected = document.getSelection()?.anchorNode;
  const element =
    selected instanceof Element ? selected : selected?.parentElement;
  const selectionColumn =
    element?.closest<HTMLElement>("[data-message-column]") ?? null;
  if (selectionColumn) return anchorFromColumn(selectionColumn);
  const preview = speakableText(text).replace(/\s+/gu, " ").slice(0, 70);
  const column = Array.from(
    document.querySelectorAll<HTMLElement>("[data-message-column]"),
  ).find(
    (c) => preview && c.textContent?.replace(/\s+/gu, " ").includes(preview),
  );
  return anchorFromColumn(column ?? null);
}
function showPlayer(record: SessionRecord, anchor: HTMLElement): void {
  for (const other of sessions.values()) {
    if (other !== record && other.anchor === anchor) {
      other.wantedPanel = false;
      other.view?.dispose();
      other.view = null;
    }
  }
  record.anchor = anchor;
  record.wantedPanel = true;
  const column = anchor.closest<HTMLElement>("[data-message-column]");
  const row = anchor.closest<HTMLElement>("[data-timeline-row-id]");
  record.rowId = row?.dataset.timelineRowId ?? null;
  record.columnIndex =
    row && column
      ? Array.from(row.querySelectorAll("[data-message-column]")).indexOf(
          column,
        )
      : 0;
  record.button =
    anchor.querySelector<HTMLElement>(`button[aria-label="${ACTION_TITLE}"]`) ??
    record.button;
  if (record.view) record.view.move(anchor);
  else
    record.view = mountPlayer(anchor, record.session, {
      activate: () => focusRecord(record),
    });
}
function restorePanels(): void {
  for (const record of sessions.values()) {
    if (
      !record.wantedPanel ||
      record.view?.element.isConnected ||
      !record.rowId
    )
      continue;
    const row = Array.from(
      document.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    ).find((r) => r.dataset.timelineRowId === record.rowId);
    const column =
      row?.querySelectorAll<HTMLElement>("[data-message-column]")[
        record.columnIndex
      ] ?? null;
    const anchor = anchorFromColumn(column);
    if (anchor) showPlayer(record, anchor);
  }
}

/** Live engine state for the settings page, so the active voice is visible. */
function ReadAloudStatus() {
  const client = useRpc<typeof rpcContract>();
  const [state, setState] = useState<
    | {
        source: string;
        ready: boolean;
        voice: string;
        voices: string[];
        message: string | null;
      }
    | null
    | "failed"
  >(null);

  useEffect(() => {
    client
      .call("status", { threadId: null })
      .then(setState, () => setState("failed"));
  }, [client]);

  if (state === null) return <p className="text-sm">Checking the engine…</p>;
  if (state === "failed")
    return <p className="text-sm">The plugin did not answer.</p>;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div>
        Source: <b>{state.source}</b> ·{" "}
        {state.ready ? "engine is answering" : "engine is not answering"}
      </div>
      <div>
        Reading with: <b>{state.voice}</b>
        {state.voices.length > 0 && !state.voices.includes(state.voice) ? (
          <span> — not installed, so nothing will be spoken</span>
        ) : null}
      </div>
      {state.voices.length > 0 ? (
        <div>Installed voices: {state.voices.join(", ")}</div>
      ) : null}
      {state.message !== null ? <div>{state.message}</div> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "speak",
    title: ACTION_TITLE,
    icon: "Play",
    async run({ threadId, message, selectedText }) {
      const generation = ++actionGeneration;
      const selection = (selectedText ?? "").trim();
      const text = selection || message.text;
      if (!text.trim()) return;
      const key = JSON.stringify([threadId, message.id, text]);
      const anchor = findAnchor(text);
      const previous = sessions.get(key);
      if (previous) {
        if (anchor) showPlayer(previous, anchor);
        const state = previous.session.snapshot().state;
        if (
          active === previous &&
          (state === "playing" || state === "buffering")
        )
          previous.session.pause();
        else {
          focusRecord(previous);
          previous.session.play();
        }
        return;
      }
      stopReading();
      const button = pressedButton;
      button?.setAttribute(PLAYING_ATTRIBUTE, "true");
      try {
        activatePlayback();
        // Split only: no UI HTTP request waits for synthesis.
        const prepared = await rpc<{ chunks: string[] }>("prepare", {
          text,
          threadId,
        });
        if (generation !== actionGeneration) return;
        if (!prepared.chunks.length) throw new Error("Nothing to read.");
        const format = preferredFormat();
        const client = new ChunkClient((method, input, signal) =>
          rpc(method, input, signal),
        );
        const session = new ReadingSession(prepared.chunks, {
          synthesize: (index, retry) =>
            client.get(prepared.chunks[index]!, threadId, format, retry),
          decode: (audio) => decodePlayback(audioBytes(audio)),
          createPlayback: () => {
            const playback = new ChunkPlayback();
            return {
              get currentTime() {
                return playback.currentTime;
              },
              stop: () => playback.stop(),
              play: (buffer, offset) => playback.playBuffer(buffer, offset),
            };
          },
        });
        const record: SessionRecord = {
          key,
          session,
          client,
          view: null,
          button,
          anchor: null,
          rowId: null,
          columnIndex: 0,
          wantedPanel: true,
          unsubscribe: () => {},
        };
        record.unsubscribe = session.subscribe(() => {
          const state = session.snapshot().state;
          if (state === "playing" || state === "buffering")
            record.button?.setAttribute(PLAYING_ATTRIBUTE, "true");
          else record.button?.removeAttribute(PLAYING_ATTRIBUTE);
        });
        sessions.set(key, record);
        if (anchor) showPlayer(record, anchor);
        focusRecord(record);
        session.play();
        while (sessions.size > 3) {
          const older = [...sessions.values()].find((r) => r !== active);
          if (!older) break;
          sessions.delete(older.key);
          disposeRecord(older);
        }
      } catch (cause) {
        button?.removeAttribute(PLAYING_ATTRIBUTE);
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  app.slots.settingsSection({
    id: "engine-status",
    title: "Engine",
    description: "What is installed and which voice is being used right now.",
    component: ReadAloudStatus,
  });

  app.contentScripts.register({
    id: "play-stop-icon",
    mount() {
      // BB renders the action icon; the registration cannot change it while a
      // reading runs. Swapping the glyph in place keeps one button doing both
      // jobs, which is what the Claude app does and what the owner asked for.
      const style = document.createElement("style");
      style.textContent = `
        /*
         * BB reveals a message's actions on hover, and on narrow touch screens
         * moves plugin actions into an overflow menu instead. A tablet is
         * neither: too wide for the mobile rule, and with no pointer to hover,
         * so the button exists and is never visible. Show it on any touch
         * screen, which also puts it in the row on a phone rather than two
         * taps deep.
         */
        @media (pointer: coarse), (any-pointer: coarse) {
          button[aria-label="${ACTION_TITLE}"] {
            display: inline-flex !important;
            opacity: 1 !important;
          }
          /* Bigger finger targets, while keeping the rest of the toolbar compact. */
          button[aria-label="${ACTION_TITLE}"],
          button[aria-label="Start voice input"],
          button[aria-label="Stop voice input"],
          button[aria-label="Stop recording"],
          button[aria-label="Cancel voice input"] {
            box-sizing: border-box;
            min-width: 48px !important;
            min-height: 48px !important;
            width: 48px !important;
            height: 48px !important;
            flex-shrink: 0;
            border-radius: 14px !important;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
          }
          /* Voice input has inverted native colors. Preserve its background
           * so its icon stays visible in both light and dark themes. */
          button[aria-label="${ACTION_TITLE}"] {
            background: color-mix(in srgb, currentColor 7%, transparent);
          }
          button[aria-label="${ACTION_TITLE}"] svg,
          button[aria-label="Start voice input"] svg,
          button[aria-label="Stop voice input"] svg,
          button[aria-label="Stop recording"] svg,
          button[aria-label="Cancel voice input"] svg {
            width: 22px !important;
            height: 22px !important;
          }
          button[aria-label="${ACTION_TITLE}"]:active {
            background: color-mix(in srgb, currentColor 14%, transparent);
          }
        }
        button[${PLAYING_ATTRIBUTE}] > * { visibility: hidden; }
        button[${PLAYING_ATTRIBUTE}] {
          position: relative;
        }
        button[${PLAYING_ATTRIBUTE}]::after {
          content: "";
          position: absolute;
          inset: 0;
          margin: auto;
          width: 0.62em;
          height: 0.62em;
          border-radius: 1px;
          background: currentColor;
        }
      `;
      document.head.append(style);

      const isReadAloudButton = (element: Element): boolean =>
        (element.getAttribute("aria-label") ??
          element.getAttribute("title")) === ACTION_TITLE;

      // The click that triggers `run` passes here first, so the element the
      // user pressed is known before the reading starts.
      const onClick = (event: Event) => {
        const button = (event.target as Element | null)?.closest?.("button");
        if (button && isReadAloudButton(button)) {
          pressedButton = button;
          pressedAt = Date.now();
          // Capture runs inside the trusted user gesture, before any SDK/RPC wait.
          try {
            activatePlayback();
          } catch {
            /* run reports a playback error */
          }
        }
      };
      document.addEventListener("click", onClick, true);
      let restoreTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new MutationObserver(() => {
        if (
          restoreTimer !== null ||
          ![...sessions.values()].some(
            (r) => r.wantedPanel && !r.view?.element.isConnected,
          )
        )
          return;
        restoreTimer = setTimeout(() => {
          restoreTimer = null;
          restorePanels();
        }, 100);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Recording and playback at once is never wanted: the microphone would
      // hear the reading. Patching getUserMedia catches every way the app can
      // start recording — the composer's voice input and Handsfree alike.
      const media = navigator.mediaDevices;
      const originalGetUserMedia = media?.getUserMedia?.bind(media);
      if (originalGetUserMedia) {
        media.getUserMedia = (constraints?: MediaStreamConstraints) => {
          if (constraints?.audio) stopReading();
          return originalGetUserMedia(constraints);
        };
      }

      return () => {
        document.removeEventListener("click", onClick, true);
        if (originalGetUserMedia && media) {
          media.getUserMedia = originalGetUserMedia;
        }
        observer.disconnect();
        if (restoreTimer !== null) clearTimeout(restoreTimer);
        style.remove();
        actionGeneration++;
        for (const record of sessions.values()) disposeRecord(record);
        sessions.clear();
        active = null;
        disposePlayback();
      };
    },
  });
});
