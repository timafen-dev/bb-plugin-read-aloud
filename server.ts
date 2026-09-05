// bb-plugin-read-aloud — backend.
//
// One job: turn the text of a chat message into spoken audio.
//
// BB has no text-to-speech of its own, and the ChatGPT subscription token is
// not admitted to OpenAI's /v1/audio/speech endpoint (it answers 401 "Missing
// scopes: api.model.audio.request"). So this plugin speaks through the OpenAI
// platform API with the user's own key, which also means it works for anyone
// who installs it — no Codex login required.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";

/** OpenAI rejects an input longer than this, so long messages are split. */
const MAX_INPUT_CHARS = 4000;

/** Refuse absurd inputs outright rather than spending minutes of audio on them. */
const MAX_TOTAL_CHARS = 40_000;

const REQUEST_TIMEOUT_MS = 120_000;

export const VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export const MODELS = ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"] as const;

export const rpcContract = defineRpcContract({
  /** Speak one message. Returns base64 MP3 the frontend plays directly. */
  speak: {
    input: z
      .object({ text: z.string().min(1).max(MAX_TOTAL_CHARS) })
      .strict(),
    output: z
      .object({
        audioBase64: z.string(),
        mimeType: z.string(),
        /** Characters actually spoken, after stripping markdown noise. */
        spokenChars: z.number().int().nonnegative(),
      })
      .strict(),
  },
  /** Whether a key is configured, so the frontend can say so precisely. */
  status: {
    input: z.null(),
    output: z
      .object({ configured: z.boolean(), voice: z.string(), model: z.string() })
      .strict(),
  },
});

/**
 * Strip the markdown that reads badly aloud while keeping every word.
 * Fenced code blocks are dropped outright — a voice reading YAML helps nobody.
 */
export function speakableText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s{0,3}[-*+]\s+/gmu, "")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(\*|_)(.*?)\1/gu, "$2")
    .replace(/^\s*\|.*\|\s*$/gmu, " ")
    .replace(/^\s*[-:|\s]+$/gmu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/**
 * Split into pieces OpenAI will accept, preferring paragraph then sentence
 * boundaries so the seam between two audio chunks lands where a reader would
 * pause anyway. A single unbroken run longer than the limit is hard-cut.
 */
export function splitForSpeech(text: string, limit = MAX_INPUT_CHARS): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const seam = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const cut = seam > limit * 0.5 ? seam + 1 : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail.length > 0) chunks.push(tail);
  return chunks.filter((chunk) => chunk.length > 0);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    openaiApiKey: {
      type: "string",
      secret: true,
      label: "OpenAI API key",
      description:
        "Needed to speak. A ChatGPT subscription cannot be used here: OpenAI does not admit subscription tokens to its speech endpoint. Create a key at platform.openai.com.",
      default: "",
    },
    voice: {
      type: "select",
      label: "Voice",
      description: "Preview every voice at platform.openai.com/docs/guides/text-to-speech.",
      options: [...VOICES],
      default: "alloy",
    },
    model: {
      type: "select",
      label: "Model",
      description:
        "gpt-4o-mini-tts is the current, cheapest and most expressive model, and the only one that follows the reading-style instructions below.",
      options: [...MODELS],
      default: "gpt-4o-mini-tts",
    },
    instructions: {
      type: "string",
      label: "Reading style",
      description:
        "Plain-language direction for how to read, e.g. \"calm, unhurried, like a colleague explaining\". Used by gpt-4o-mini-tts only.",
      default: "Read clearly and naturally, at a calm pace.",
    },
  });

  async function requestSpeech(
    chunk: string,
    key: string,
    voice: string,
    model: string,
    instructions: string,
  ): Promise<Uint8Array> {
    const body: Record<string, unknown> = {
      model,
      voice,
      input: chunk,
      response_format: "mp3",
    };
    // Only gpt-4o-mini-tts accepts instructions; the tts-1 family 400s on it.
    if (model === "gpt-4o-mini-tts" && instructions.trim().length > 0) {
      body.instructions = instructions.trim();
    }
    const response = await fetch(SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Never surface the response body verbatim: it can echo request content.
      const hint =
        response.status === 401
          ? "OpenAI rejected the key. Check Settings → Plugins → Read Aloud."
          : response.status === 429
            ? "OpenAI is rate limiting or the account has no credit."
            : `OpenAI returned HTTP ${response.status}.`;
      bb.log.error(`speech request failed: HTTP ${response.status}`);
      throw new Error(hint);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  bb.rpc.register(rpcContract, {
    async status() {
      const { openaiApiKey, voice, model } = await settings.get();
      return {
        configured: openaiApiKey.trim().length > 0,
        voice,
        model,
      };
    },
    async speak({ text }) {
      const { openaiApiKey, voice, model, instructions } = await settings.get();
      const key = openaiApiKey.trim();
      if (key.length === 0) {
        throw new Error(
          "No OpenAI API key set. Settings → Plugins → Read Aloud.",
        );
      }
      const spoken = speakableText(text);
      if (spoken.length === 0) {
        throw new Error("Nothing to read: the message is only code or images.");
      }
      const chunks = splitForSpeech(spoken);
      // MP3 frames concatenate cleanly, so several requests play as one take.
      const parts: Uint8Array[] = [];
      for (const chunk of chunks) {
        parts.push(await requestSpeech(chunk, key, voice, model, instructions));
      }
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
      }
      return {
        audioBase64: Buffer.from(merged).toString("base64"),
        mimeType: "audio/mpeg",
        spokenChars: spoken.length,
      };
    },
  });
}
