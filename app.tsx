// bb-plugin-read-aloud — frontend.
//
// Adds one action to every chat message: speak it. It also appears in the
// text-selection menu, so a highlighted paragraph is read instead of the whole
// message.
//
// Long messages are spoken as a queue: the first piece starts playing while
// the rest are still being synthesized, so a three-thousand-character answer
// begins within a second or two instead of after ten seconds of silence.
//
// `run` is a plain callback, not a React component, so the SDK's useRpc hook
// cannot be used. The RPC route is the documented, same-origin
// POST /api/v1/plugins/<id>/rpc/<method> — exactly what useRpc calls.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const PLUGIN_ID = "read-aloud";
const RPC_URL = `/api/v1/plugins/${PLUGIN_ID}/rpc`;

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
  return probe.canPlayType('audio/ogg; codecs="opus"') !== ""
    ? "opus"
    : "mp3";
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
    const message =
      typeof error?.message === "string"
        ? error.message
        : typeof asRecord.message === "string"
          ? asRecord.message
          : `Read aloud failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return (("result" in asRecord ? asRecord.result : payload) as T);
}

function toBlobUrl({ audioBase64, mimeType }: ChunkAudio): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/** One reading at a time across the whole app. */
class Reading {
  private audio: HTMLAudioElement | null = null;
  private urls: string[] = [];
  private cancelled = false;

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

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "speak",
    title: "Read aloud",
    icon: "Volume2",
    async run({ threadId, message, selectedText }) {
      const wasReading = active;
      active?.cancel();
      active = null;
      // Second click on the message already speaking = stop. A click on a
      // different message replaces the reading rather than talking over it.
      if (
        wasReading !== null &&
        wasReading.messageId === message.id &&
        (selectedText ?? "").length === 0
      ) {
        return;
      }

      const text = (selectedText ?? "").trim() || message.text;
      if (text.trim().length === 0) {
        toast.error("Nothing to read in this message.");
        return;
      }

      const reading = new Reading(message.id);
      active = reading;
      const pending = toast.loading("Reading aloud…");
      try {
        const { chunks } = await rpc<{ chunks: string[] }>("prepare", {
          text,
          threadId,
        });
        if (chunks.length === 0) throw new Error("Nothing to read.");
        if (reading.stopped) return;
        await reading.run(chunks, threadId, preferredFormat());
        toast.dismiss(pending);
      } catch (cause) {
        toast.dismiss(pending);
        reading.cancel();
        if (active === reading) active = null;
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
});
