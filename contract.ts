// Shared between server.ts and host.ts: the plugin server runs inside the BB
// server container and cannot reach the speech engine on the user's machine.
// The host entry runs on that machine and is the only thing that can.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Audio containers the engine can return, newest-first by preference. */
export const AUDIO_FORMATS = ["opus", "mp3", "wav"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/**
 * One host call must fit inside the daemon's RPC limits: 30 s and 8 MiB, with
 * no streaming. A 1500-character chunk synthesizes in about a second and
 * encodes to well under a megabyte, leaving plenty of headroom.
 */
export const MAX_CHUNK_CHARS = 1500;

export const HOST_CALL_TIMEOUT_MS = 25_000;

export const hostContract = defineRpcContract({
  /** Whether the engine answers, and which voices it has. */
  probe: {
    input: z.object({ engineUrl: z.string().min(1) }).strict(),
    output: z
      .object({
        reachable: z.boolean(),
        engine: z.string().nullable(),
        voices: z.array(z.string()),
        message: z.string().nullable(),
      })
      .strict(),
  },
  /** Speak one chunk. Base64 because host RPC carries JSON, not binary. */
  speak: {
    input: z
      .object({
        engineUrl: z.string().min(1),
        text: z.string().min(1).max(MAX_CHUNK_CHARS),
        voice: z.string().min(1),
        rate: z.number().min(0.5).max(2),
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
});
