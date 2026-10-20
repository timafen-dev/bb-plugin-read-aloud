import assert from "node:assert/strict";
import { test } from "node:test";
import { ChunkClient } from "../chunk-client.ts";
test("client polls short status requests and returns original audio", async () => {
  const methods: string[] = [];
  let polls = 0;
  const audio = {
    audioBase64: "original",
    mimeType: "audio/mpeg",
    cached: false,
  };
  const client = new ChunkClient(
    async (method) => {
      methods.push(method);
      return method === "requestChunk"
        ? { jobId: "one" }
        : ++polls === 1
          ? { state: "pending", audio: null, message: null }
          : { state: "ready", audio, message: null };
    },
    async () => {},
  );
  assert.deepEqual(await client.get("text", null, "mp3"), audio);
  assert.deepEqual(methods, ["requestChunk", "chunkStatus", "chunkStatus"]);
  client.dispose();
});
test("explicit continuation sends only the failed job id and disposal aborts polling", async () => {
  const inputs: unknown[] = [];
  let fail = true;
  const client = new ChunkClient(
    async (method, input) => {
      inputs.push(input);
      return method === "requestChunk"
        ? { jobId: "failed" }
        : fail
          ? { state: "error", audio: null, message: "provider failed" }
          : {
              state: "ready",
              audio: {
                audioBase64: "fixed",
                mimeType: "audio/mpeg",
                cached: false,
              },
              message: null,
            };
    },
    async () => {},
  );
  await assert.rejects(client.get("text", null, "mp3"), /provider failed/);
  fail = false;
  await client.get("text", null, "mp3", true);
  assert.ok(
    inputs.some((x) => (x as { retryJobId?: string }).retryJobId === "failed"),
  );
  client.dispose();
  await assert.rejects(client.get("text", null, "mp3"), /abort|disposed/i);
});
