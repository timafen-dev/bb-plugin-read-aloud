import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const settings = {
  source: "openai",
  voice: "marin",
  rate: "1.2",
  openaiApiKey: "test-only-key",
  openaiModel: "gpt-4o-mini-tts",
};

test("a long reading starts with short audio and delivers every word in bounded requests", async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(new Uint8Array([73, 68, 51, 0]));
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "read-aloud", settings });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const text = "Большой ответ должен читаться полностью, без потери слов и долгого ожидания. ".repeat(70).trim();
  const result = await harness.behavior.callRpc("prepare", {
    text, threadId: null, format: "mp3",
  }) as { chunks: string[]; first: { audioBase64: string } };
  assert.ok(result.first.audioBase64.length > 0);
  assert.ok(result.chunks.length > 3);
  assert.ok(result.chunks[0]!.length <= 180);
  assert.ok(result.chunks.every((chunk) => chunk.length <= 800));
  assert.equal(result.chunks.join(" "), text);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.input, result.chunks[0]);
  for (const chunk of result.chunks.slice(1)) {
    await harness.behavior.callRpc("speakChunk", { chunk, threadId: null, format: "mp3" });
  }
  assert.equal(requests.map((request) => request.input).join(" "), text);
  assert.ok(requests.every((request) => request.voice === "marin" && request.speed === 1.2));
});

test("a stalled audio body returns a readable error before the gateway deadline", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.ok(ms > 0 && ms < 30_000);
    return controller.signal;
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => ({
    ok: true,
    arrayBuffer: () => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      controller.abort(new DOMException("timed out", "TimeoutError"));
    }),
  }));
  const { bb, harness } = createFakePluginHost({ pluginId: "read-aloud", settings });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(
    harness.behavior.callRpc("prepare", { text: "Проверка ожидания.", threadId: null, format: "mp3" }),
    /Сервис озвучки не ответил вовремя/,
  );
});
