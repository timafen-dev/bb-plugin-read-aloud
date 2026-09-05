// bb-plugin-read-aloud — backend.
//
// Speaks the text of a chat message. The plugin server runs inside the BB
// server container, so it cannot reach a speech engine on the user's machine:
// host.ts does that, and this file decides what to say, in what pieces, and by
// which route.
//
// Default route is a local Piper engine (MIT) on the user's own machine — no
// key, no account, no text leaving the machine. OpenAI is an opt-in
// alternative. A ChatGPT subscription cannot be used for either: OpenAI
// refuses subscription tokens at its speech endpoint with
// "Missing scopes: api.model.audio.request".
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  AUDIO_FORMATS,
  hostContract,
  MAX_CHUNK_CHARS,
  type AudioFormat,
} from "./contract.js";
import {
  CHUNK_SIZE_RAMP,
  normalizeForSpeech,
  speakableText,
  splitForSpeech,
} from "./text.ts";

const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";

/** Refuse absurd inputs rather than spending minutes of audio on them. */
const MAX_TOTAL_CHARS = 40_000;

/** OpenAI accepts far more per request than one host RPC call can carry. */
const OPENAI_MAX_CHARS = 4_000;

export const SOURCES = ["local", "openai"] as const;
export type Source = (typeof SOURCES)[number];

export const rpcContract = defineRpcContract({
  /** Split a message into speakable pieces and confirm a route exists. */
  prepare: {
    input: z
      .object({
        text: z.string().min(1).max(MAX_TOTAL_CHARS),
        threadId: z.string().nullable(),
        /** Omit to receive the split alone, without waiting for audio. */
        format: z.enum(AUDIO_FORMATS).optional(),
      })
      .strict(),
    output: z
      .object({
        chunks: z.array(z.string()),
        source: z.enum(SOURCES),
        voice: z.string(),
        /** Audio for the first piece, so speaking starts after one round trip. */
        first: z
          .object({
            audioBase64: z.string(),
            mimeType: z.string(),
            cached: z.boolean(),
          })
          .nullable(),
      })
      .strict(),
  },
  /** Speak one piece. Base64 because RPC carries JSON, not binary. */
  speakChunk: {
    input: z
      .object({
        chunk: z.string().min(1),
        threadId: z.string().nullable(),
        format: z.enum(AUDIO_FORMATS),
      })
      .strict(),
    output: z
      .object({
        audioBase64: z.string(),
        mimeType: z.string(),
        cached: z.boolean(),
      })
      .strict(),
  },
  /** Which route is configured and whether it currently answers. */
  status: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: z
      .object({
        source: z.enum(SOURCES),
        ready: z.boolean(),
        voice: z.string(),
        voices: z.array(z.string()),
        message: z.string().nullable(),
      })
      .strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    source: {
      type: "select",
      label: "Speech source",
      description:
        "Local engine runs on your own machine: no key, no account, and the text never leaves it. OpenAI is billed to your own API key.",
      options: [...SOURCES],
      default: "local",
    },
    voice: {
      type: "string",
      label: "Voice",
      description:
        "Local engine: a Piper voice id such as ru_RU-dmitri-medium. OpenAI: one of alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse.",
      default: "ru_RU-dmitri-medium",
    },
    rate: {
      type: "string",
      label: "Speed",
      description: "1 is normal. Half speed is 0.5, double is 2.",
      default: "1.0",
    },
    engineUrl: {
      type: "string",
      label: "Local engine address",
      description:
        "Where the engine listens on your machine. Change this only if you moved it off the default port.",
      default: "http://127.0.0.1:5077",
    },
    machineId: {
      type: "string",
      label: "Machine (optional)",
      description:
        "Leave blank to use the machine the open thread runs on. Set a host id to pin every reading to one machine.",
      default: "",
    },
    openaiApiKey: {
      type: "string",
      secret: true,
      label: "OpenAI API key",
      description:
        "Only used when the source above is set to OpenAI. A ChatGPT subscription cannot be used: OpenAI refuses subscription tokens at its speech endpoint.",
      default: "",
    },
    openaiModel: {
      type: "select",
      label: "OpenAI model",
      options: ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"],
      default: "gpt-4o-mini-tts",
    },
    openaiInstructions: {
      type: "string",
      label: "OpenAI reading style",
      description:
        "Plain-language direction, e.g. \"calm, unhurried\". Followed by gpt-4o-mini-tts only.",
      default: "Read clearly and naturally, at a calm pace.",
    },
  });

  const engineHost = bb.hosts.experimental_client({ contract: hostContract });

  /**
   * Which machine a thread reads on rarely changes, and asking costs two or
   * three round trips inside the server — measurably more than the synthesis
   * itself. Remember the answer briefly.
   */
  const hostByThread = new Map<string, { hostId: string; at: number }>();
  const HOST_CACHE_MS = 5 * 60_000;

  /** Settings return plain strings; narrow at the boundary, once. */
  function parseSource(raw: string): Source {
    return (SOURCES as readonly string[]).includes(raw)
      ? (raw as Source)
      : "local";
  }

  function parseRate(raw: string): number {
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return 1;
    return Math.min(2, Math.max(0.5, value));
  }

  /**
   * Read on the machine the conversation is running on, so a thread on the
   * laptop is not spoken by the desktop's engine. An explicit setting wins.
   */
  async function resolveHostId(threadId: string | null): Promise<string> {
    const { machineId } = await settings.get();
    if (machineId.trim().length > 0) return machineId.trim();
    const key = threadId ?? "";
    const remembered = hostByThread.get(key);
    if (remembered && Date.now() - remembered.at < HOST_CACHE_MS) {
      return remembered.hostId;
    }
    const found = await lookUpHostId(threadId);
    hostByThread.set(key, { hostId: found, at: Date.now() });
    return found;
  }

  async function lookUpHostId(threadId: string | null): Promise<string> {
    if (threadId !== null) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) {
          const environment = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
          if (environment.hostId) return environment.hostId;
        }
      } catch {
        // Fall through to the primary host below.
      }
    }
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((host) => host.status === "connected");
    if (!connected) throw new Error("No connected machine can speak this.");
    return connected.id;
  }

  async function speakLocally(
    chunk: string,
    threadId: string | null,
    format: AudioFormat,
  ) {
    const { voice, rate, engineUrl } = await settings.get();
    const hostId = await resolveHostId(threadId);
    return engineHost.call(
      "speak",
      { engineUrl, text: chunk, voice, rate: parseRate(rate), format },
      { hostId },
    );
  }

  async function speakViaOpenai(chunk: string) {
    const { openaiApiKey, openaiModel, openaiInstructions, voice, rate } =
      await settings.get();
    const key = openaiApiKey.trim();
    if (key.length === 0) {
      throw new Error(
        "OpenAI is selected but no API key is set. Settings → Plugins → Read Aloud.",
      );
    }
    const body: Record<string, unknown> = {
      model: openaiModel,
      voice,
      input: chunk,
      response_format: "mp3",
      speed: parseRate(rate),
    };
    // Only gpt-4o-mini-tts accepts instructions; the tts-1 family rejects them.
    if (openaiModel === "gpt-4o-mini-tts" && openaiInstructions.trim()) {
      body.instructions = openaiInstructions.trim();
      delete body.speed;
    }
    const response = await fetch(OPENAI_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      // Never echo the response body: it can repeat the request content.
      bb.log.error(`OpenAI speech failed: HTTP ${response.status}`);
      throw new Error(
        response.status === 401
          ? "OpenAI rejected the key. Settings → Plugins → Read Aloud."
          : response.status === 429
            ? "OpenAI is rate limiting, or the account has no credit."
            : `OpenAI returned HTTP ${response.status}.`,
      );
    }
    const audio = Buffer.from(await response.arrayBuffer());
    return {
      audioBase64: audio.toString("base64"),
      mimeType: "audio/mpeg",
      cached: false,
    };
  }

  bb.rpc.register(rpcContract, {
    async status({ threadId }) {
      const stored = await settings.get();
      const source = parseSource(stored.source);
      const { voice, engineUrl, openaiApiKey } = stored;
      if (source === "openai") {
        const configured = openaiApiKey.trim().length > 0;
        return {
          source,
          ready: configured,
          voice,
          voices: [],
          message: configured
            ? null
            : "No OpenAI API key set. Settings → Plugins → Read Aloud.",
        };
      }
      try {
        const hostId = await resolveHostId(threadId);
        const probe = await engineHost.call("probe", { engineUrl }, { hostId });
        return {
          source,
          ready: probe.reachable && probe.voices.length > 0,
          voice,
          voices: probe.voices,
          message: probe.reachable ? null : probe.message,
        };
      } catch (cause) {
        return {
          source,
          ready: false,
          voice,
          voices: [],
          message:
            cause instanceof Error
              ? `The machine with the speech engine is not reachable. ${cause.message}`
              : String(cause),
        };
      }
    },

    async prepare({ text, threadId, format }) {
      const stored = await settings.get();
      const source = parseSource(stored.source);
      const { voice } = stored;
      const spoken = normalizeForSpeech(speakableText(text));
      if (spoken.length === 0) {
        throw new Error("Nothing to read: this message is only code or images.");
      }
      // OpenAI charges per request and has no per-call latency worth shaving,
      // so it keeps one large size; the local engine ramps up from a short
      // first piece.
      const sizes =
        source === "openai" ? [OPENAI_MAX_CHARS] : CHUNK_SIZE_RAMP;
      const chunks = splitForSpeech(spoken, sizes);
      // Returning the first piece's audio here saves a whole round trip
      // before the voice starts, which is most of the wait on a short piece.
      const first =
        format === undefined || chunks.length === 0
          ? null
          : source === "openai"
            ? await speakViaOpenai(chunks[0]!)
            : await speakLocally(chunks[0]!, threadId, format);
      return { chunks, source, voice, first };
    },

    async speakChunk({ chunk, threadId, format }) {
      const source = parseSource((await settings.get()).source);
      return source === "openai"
        ? speakViaOpenai(chunk)
        : speakLocally(chunk, threadId, format);
    },
  });
}
