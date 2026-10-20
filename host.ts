// Runs on the user's machine, next to the speech engine.
//
// Deliberately thin: it forwards one chunk to the local engine and hands the
// audio back. Everything else — chunking, markdown stripping, settings — stays
// on the server side where it can be tested without a machine attached.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, HOST_CALL_TIMEOUT_MS } from "./contract.js";

const MIME_BY_FORMAT: Record<string, string> = {
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/**
 * "Not installed" and "machine offline" look identical from the server, so the
 * distinction has to be drawn here, where the failure actually happens.
 */
function describeFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/iu.test(message)) {
    return "The speech engine is not answering on this machine. Run engine/install-tts.sh to install it.";
  }
  if (/abort|timeout/iu.test(message)) {
    return "The speech engine did not answer in time.";
  }
  return message;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    probe: async ({ engineUrl }, context) => {
      try {
        const response = await fetch(new URL("/health", engineUrl), {
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(5_000),
          ]),
        });
        if (!response.ok) {
          return {
            reachable: false,
            engine: null,
            voices: [],
            message: `The speech engine answered HTTP ${response.status}.`,
          };
        }
        const body = (await response.json()) as {
          engine?: unknown;
          voices?: unknown;
        };
        return {
          reachable: true,
          engine: typeof body.engine === "string" ? body.engine : null,
          voices: Array.isArray(body.voices)
            ? body.voices.filter((v): v is string => typeof v === "string")
            : [],
          message: null,
        };
      } catch (cause) {
        return {
          reachable: false,
          engine: null,
          voices: [],
          message: describeFailure(cause),
        };
      }
    },

    speak: async ({ engineUrl, text, voice, rate, format }, context) => {
      const response = await fetch(new URL("/speak", engineUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice, rate, format }),
        signal: AbortSignal.any([
          context.signal,
          AbortSignal.timeout(HOST_CALL_TIMEOUT_MS),
        ]),
      }).catch((cause: unknown) => {
        throw new Error(describeFailure(cause));
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          response.status === 404
            ? `The engine has no voice called "${voice}".`
            : `The speech engine returned HTTP ${response.status}. ${detail.slice(0, 200)}`,
        );
      }

      const audio = Buffer.from(await response.arrayBuffer());
      return {
        audioBase64: audio.toString("base64"),
        mimeType:
          response.headers.get("content-type") ??
          MIME_BY_FORMAT[format] ??
          "application/octet-stream",
        cached: response.headers.get("x-cache") === "hit",
      };
    },
  },
});
