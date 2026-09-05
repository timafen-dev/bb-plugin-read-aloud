// bb-plugin-read-aloud — frontend.
//
// Adds one action to every chat message: speak it. The action also appears in
// the text-selection menu, so a highlighted paragraph is read instead of the
// whole message.
//
// `run` is a plain callback, not a React component, so the SDK's useRpc hook
// cannot be used here. The RPC route is the documented, same-origin
// POST /api/v1/plugins/<id>/rpc/<method>, which is exactly what useRpc calls.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const PLUGIN_ID = "read-aloud";
const RPC_URL = `/api/v1/plugins/${PLUGIN_ID}/rpc`;

interface SpeakResult {
  audioBase64: string;
  mimeType: string;
  spokenChars: number;
}

/** One player for the whole app: starting a new reading stops the previous. */
let current: { audio: HTMLAudioElement; url: string; messageId: string } | null =
  null;

function stopCurrent(): string | null {
  if (current === null) return null;
  const { audio, url, messageId } = current;
  current = null;
  audio.pause();
  audio.src = "";
  URL.revokeObjectURL(url);
  return messageId;
}

async function callSpeak(text: string): Promise<SpeakResult> {
  const response = await fetch(`${RPC_URL}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const payload: unknown = await response.json().catch(() => null);
  const message =
    payload !== null &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof (payload as { message: unknown }).message === "string"
      ? (payload as { message: string }).message
      : `Read aloud failed (HTTP ${response.status}).`;
  if (!response.ok) throw new Error(message);
  const result =
    payload !== null && typeof payload === "object" && "result" in payload
      ? (payload as { result: unknown }).result
      : payload;
  if (
    result === null ||
    typeof result !== "object" ||
    typeof (result as SpeakResult).audioBase64 !== "string"
  ) {
    throw new Error("Read aloud received an unexpected response.");
  }
  return result as SpeakResult;
}

function toBlobUrl({ audioBase64, mimeType }: SpeakResult): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "speak",
    title: "Read aloud",
    icon: "Volume2",
    async run({ message, selectedText }) {
      // Second click on the message already speaking = stop. A click on a
      // different message replaces the reading rather than overlapping it.
      const stopped = stopCurrent();
      if (stopped === message.id && (selectedText ?? "").length === 0) return;

      const text = (selectedText ?? "").trim() || message.text;
      if (text.trim().length === 0) {
        toast.error("Nothing to read in this message.");
        return;
      }

      const pending = toast.loading("Reading aloud…");
      try {
        const result = await callSpeak(text);
        const url = toBlobUrl(result);
        const audio = new Audio(url);
        current = { audio, url, messageId: message.id };
        audio.addEventListener("ended", () => {
          if (current?.audio === audio) stopCurrent();
        });
        await audio.play();
        toast.dismiss(pending);
      } catch (cause) {
        toast.dismiss(pending);
        stopCurrent();
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
});
