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

const PLUGIN_ID = "read-aloud";
const RPC_URL = `/api/v1/plugins/${PLUGIN_ID}/rpc`;
const ACTION_TITLE = "Read aloud";
const PLAYING_ATTRIBUTE = "data-read-aloud-playing";

type AudioFormat = "opus" | "mp3" | "wav";

interface ChunkAudio {
  audioBase64: string;
  mimeType: string;
  cached: boolean;
}

/**
 * Safari on iOS does not play ogg/opus. Ask the browser rather than sniffing
 * the user agent, and fall back to mp3, which every browser plays.
 */
function preferredFormat(): AudioFormat {
  const probe = document.createElement("audio");
  return probe.canPlayType('audio/ogg; codecs="opus"') !== "" ? "opus" : "mp3";
}

async function rpc<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${RPC_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
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

function toBlobUrl({ audioBase64, mimeType }: ChunkAudio): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/** The button the user actually pressed, so the ■ lands on the right message. */
let pressedButton: HTMLElement | null = null;

function markPlaying(playing: boolean): void {
  if (pressedButton === null) return;
  if (playing) pressedButton.setAttribute(PLAYING_ATTRIBUTE, "true");
  else pressedButton.removeAttribute(PLAYING_ATTRIBUTE);
}

/** One reading at a time across the whole app. */
class Reading {
  private audio: HTMLAudioElement | null = null;
  private urls: string[] = [];
  private cancelled = false;
  private button: HTMLElement | null = pressedButton;

  constructor(readonly messageId: string) {}

  cancel(): void {
    this.cancelled = true;
    if (this.audio !== null) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.button?.removeAttribute(PLAYING_ATTRIBUTE);
  }

  get stopped(): boolean {
    return this.cancelled;
  }

  private playOne(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      this.audio = audio;
      audio.addEventListener("ended", () => resolve(), { once: true });
      audio.addEventListener(
        "error",
        () => reject(new Error("The browser could not play the audio.")),
        { once: true },
      );
      audio.play().catch(reject);
    });
  }

  /**
   * Synthesize one piece ahead of the one playing: the queue never runs dry,
   * and no more than two pieces are ever in flight.
   */
  async run(
    chunks: string[],
    threadId: string,
    format: AudioFormat,
  ): Promise<void> {
    const fetchChunk = (chunk: string) =>
      rpc<ChunkAudio>("speakChunk", { chunk, threadId, format });

    let pending = fetchChunk(chunks[0]!);
    for (let index = 0; index < chunks.length; index += 1) {
      const audio = await pending;
      if (this.cancelled) return;
      const next = chunks[index + 1];
      pending = next === undefined ? pending : fetchChunk(next);
      const url = toBlobUrl(audio);
      this.urls.push(url);
      await this.playOne(url);
      if (this.cancelled) return;
    }
  }
}

let active: Reading | null = null;

function stopReading(): void {
  active?.cancel();
  active = null;
  markPlaying(false);
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
      const wasReading = active;
      stopReading();
      // Second press on the message already speaking = stop. A press on a
      // different message replaces the reading rather than talking over it.
      if (
        wasReading !== null &&
        wasReading.messageId === message.id &&
        (selectedText ?? "").length === 0
      ) {
        return;
      }

      const text = (selectedText ?? "").trim() || message.text;
      if (text.trim().length === 0) return;

      const reading = new Reading(message.id);
      active = reading;
      markPlaying(true);
      try {
        const { chunks } = await rpc<{ chunks: string[] }>("prepare", {
          text,
          threadId,
        });
        if (reading.stopped) return;
        if (chunks.length === 0) throw new Error("Nothing to read.");
        await reading.run(chunks, threadId, preferredFormat());
      } catch (cause) {
        // Errors are the one thing worth interrupting for; progress is not.
        toast.error(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active === reading) {
          reading.cancel();
          active = null;
        }
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
        @media (pointer: coarse) {
          button[aria-label="${ACTION_TITLE}"] {
            display: inline-flex !important;
            opacity: 1 !important;
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
        (element.getAttribute("aria-label") ?? element.getAttribute("title")) ===
        ACTION_TITLE;

      // The click that triggers `run` passes here first, so the element the
      // user pressed is known before the reading starts.
      const onClick = (event: Event) => {
        const button = (event.target as Element | null)?.closest?.("button");
        if (button && isReadAloudButton(button)) pressedButton = button;
      };
      document.addEventListener("click", onClick, true);

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
        style.remove();
        stopReading();
      };
    },
  });
});
