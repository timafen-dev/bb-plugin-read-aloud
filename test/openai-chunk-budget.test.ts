import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { OPENAI_CHUNK_SIZE_RAMP, splitForSpeech } from "../text.ts";

const openaiSettings = {
  source: "openai",
  voice: "marin",
  rate: "1.2",
  openaiApiKey: "unit-test-placeholder",
  openaiModel: "gpt-4o-mini-tts",
};

// A real Russian 360-character chunk timed out at 25s; each <=180-character
// piece completed within the same deadline. The cap must hold for later
// chunks, not just the first one returned by prepare.
test("every OpenAI request stays within the measured 180-character budget", async (t) => {
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)).input);
      return new Response(new Uint8Array([73, 68, 51, 0]));
    },
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "read-aloud",
    settings: {
      source: "openai",
      voice: "marin",
      rate: "1.2",
      openaiApiKey: "unit-test-placeholder",
      openaiModel: "gpt-4o-mini-tts",
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const text =
    "Большой ответ должен читаться полностью, без потери слов и долгого ожидания. "
      .repeat(70)
      .trim();
  const result = (await harness.behavior.callRpc("prepare", {
    text,
    threadId: null,
    format: "mp3",
  })) as { chunks: string[]; first: { audioBase64: string } };
  assert.ok(result.first.audioBase64.length > 0);
  assert.ok(result.chunks.length > 3);
  assert.ok(
    result.chunks.every((chunk) => chunk.length <= 180),
    "later chunks must not grow past the safe request size",
  );
  for (const chunk of result.chunks.slice(1)) {
    await harness.behavior.callRpc("speakChunk", {
      chunk,
      threadId: null,
      format: "mp3",
    });
  }
  assert.equal(requests.join(" "), text);
  assert.ok(requests.every((chunk) => chunk.length <= 180));
});

test("short OpenAI chunks keep Russian words intact even in long sentences", () => {
  const text =
    "Длинное предложение должно продолжать звучать естественно и сохранять каждое русское слово "
      .repeat(20)
      .trim();
  const chunks = splitForSpeech(text, OPENAI_CHUNK_SIZE_RAMP);
  assert.equal(
    chunks.join(" "),
    text,
    "splitting must not insert a space into a word",
  );
});

test("a transient speech timeout retries the same fragment within the gateway budget", async (t) => {
  const requests: string[] = [];
  const budgets: number[] = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    budgets.push(ms);
    return timeout(ms);
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests.push(String(init.body));
      if (requests.length === 1)
        throw new DOMException("stalled", "TimeoutError");
      return new Response(new Uint8Array([73, 68, 51, 0]));
    },
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "read-aloud",
    settings: openaiSettings,
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const result = (await harness.behavior.callRpc("speakChunk", {
    chunk: "Проверка продолжения озвучки.",
    threadId: null,
    format: "mp3",
  })) as { audioBase64: string };
  assert.ok(result.audioBase64.length > 0);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0],
    requests[1],
    "retry must not lose text or change the voice",
  );
  assert.ok(
    budgets.filter((ms) => ms < 25_000).reduce((a, b) => a + b, 0) < 25_000,
  );
});

test("speech timeout recovery is bounded, not an infinite retry loop", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new DOMException("stalled", "TimeoutError");
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "read-aloud",
    settings: openaiSettings,
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(
    harness.behavior.callRpc("speakChunk", {
      chunk: "Проверка.",
      threadId: null,
      format: "mp3",
    }),
    /Сервис озвучки не ответил вовремя/,
  );
  assert.equal(calls, 2);
});

test("speech credit or rate-limit errors are not retried as timeouts", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null, { status: 429 });
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "read-aloud",
    settings: openaiSettings,
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(
    harness.behavior.callRpc("speakChunk", {
      chunk: "Проверка.",
      threadId: null,
      format: "mp3",
    }),
    /rate limiting/,
  );
  assert.equal(calls, 1);
});
