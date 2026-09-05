import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK_SIZE_RAMP,
  normalizeForSpeech,
  type PausedAt,
  resumePoint,
  speakableText,
  splitForSpeech,
} from "../text.ts";

test("drops fenced code but keeps the prose around it", () => {
  const spoken = speakableText(
    "Вот команда:\n\n```sh\ndocker run --rm -it thing\n```\n\nОна поднимает контейнер.",
  );
  assert.ok(!spoken.includes("docker"));
  assert.ok(spoken.includes("Вот команда"));
  assert.ok(spoken.includes("Она поднимает контейнер"));
});

test("keeps the words of markdown, not its punctuation", () => {
  const spoken = speakableText(
    "## Заголовок\n\n- **важное** и _наклонное_\n- [ссылка на панель](https://example.com/x)\n\n> цитата",
  );
  assert.ok(!/[#*_>]/u.test(spoken), spoken);
  assert.ok(spoken.includes("важное"));
  assert.ok(spoken.includes("наклонное"));
  assert.ok(spoken.includes("ссылка на панель"));
  assert.ok(spoken.includes("цитата"));
});

test("reads a table's words instead of its pipes", () => {
  const spoken = speakableText("| Машина | Лимит |\n| --- | --- |\n| первая | 32% |");
  assert.ok(!spoken.includes("|"));
  assert.ok(!spoken.includes("---"));
});

test("says nothing at all for a message that is only code", () => {
  assert.equal(speakableText("```py\nprint(1)\n```"), "");
});

test("normalization replaces what reads badly and leaves the rest", () => {
  const spoken = normalizeForSpeech(
    "Смотри https://github.com/a/b и файл src/server/main.py, версия 036873d5 — точно!!!",
  );
  assert.ok(spoken.includes("ссылка"));
  assert.ok(!spoken.includes("github.com"));
  assert.ok(spoken.includes("файл main.py"));
  assert.ok(spoken.includes("версия"));
  assert.ok(!spoken.includes("036873d5"));
  assert.ok(spoken.includes("точно!"));
  assert.ok(!spoken.includes("!!!"));
});

test("normalization keeps ordinary Russian text untouched", () => {
  const text = "Панель живёт на сервере, а агенты — на твоём компьютере.";
  assert.equal(normalizeForSpeech(text), text);
});

test("a short message stays one piece", () => {
  assert.deepEqual(splitForSpeech("Короткая фраза.", [1500]), ["Короткая фраза."]);
});

test("splitting prefers sentence ends over cutting mid-word", () => {
  const sentence = "Это предложение ровно на сорок девять знаков. ";
  const chunks = splitForSpeech(sentence.repeat(40), [200]);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200, `piece too long: ${chunk.length}`);
    assert.ok(/[.!?]$/u.test(chunk), `piece does not end a sentence: ${chunk}`);
  }
});

test("splitting a single unbroken run still respects the limit", () => {
  const chunks = splitForSpeech("я".repeat(500), [100]);
  assert.equal(chunks.length, 5);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
});

test("nothing is lost when a message is split", () => {
  const source = "Первое предложение. Второе предложение! Третье? Четвёртое.";
  const joined = splitForSpeech(source, [25]).join(" ").replace(/\s+/gu, " ");
  assert.equal(joined, source.replace(/\s+/gu, " "));
});

test("does not repeat a word the author already wrote", () => {
  const spoken = normalizeForSpeech(
    "Смотри файл src/main.py, версия 036873d5, и ссылка https://example.com/x",
  );
  assert.ok(!/файл\s+файл/iu.test(spoken), spoken);
  assert.ok(!/версия\s+версия/iu.test(spoken), spoken);
  assert.ok(!/ссылка\s+ссылка/iu.test(spoken), spoken);
  assert.ok(spoken.includes("файл main.py"));
});

test("a genuine repetition in ordinary prose is left alone", () => {
  assert.equal(normalizeForSpeech("Очень очень важно"), "Очень очень важно");
  assert.equal(normalizeForSpeech("Так так так"), "Так так так");
});

test("the manifest version matches the release tag it is published under", async () => {
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    ),
  ) as { version: string; bb: { host: string; server: string; app: string } };
  // v0.2.1 shipped a package.json still saying 0.2.0: the tag moved, the
  // manifest did not, and `bb plugin outdated` had no way to tell.
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.bb.host, "./host.ts");
  assert.equal(manifest.bb.server, "./server.ts");
  assert.equal(manifest.bb.app, "./app.tsx");
});

test("the manifest icon is a name BB actually has", async () => {
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    ),
  ) as { bb: { branding: { icon: string } } };
  // BB draws plugin actions with the plugin's manifest icon before the
  // action's own hint, and silently falls back to a lightning bolt for a name
  // it does not know. "Volume2" was such a name, and that is what shipped.
  const KNOWN = ["Play", "Pause", "Square", "Mic", "Zap"];
  assert.ok(
    KNOWN.includes(manifest.bb.branding.icon),
    `unknown icon: ${manifest.bb.branding.icon}`,
  );
});

const pausedAt = (over: Partial<PausedAt> = {}): PausedAt => ({
  messageId: "msg-1",
  chunks: ["первый кусок", "второй кусок"],
  index: 1,
  offset: 4.25,
  threadId: "thr-1",
  format: "mp3",
  ...over,
});

test("continues the same message from where it stopped", () => {
  const point = resumePoint(pausedAt(), "msg-1", "", "mp3");
  assert.equal(point?.index, 1);
  assert.equal(point?.offset, 4.25);
});

test("starts over on a different message", () => {
  assert.equal(resumePoint(pausedAt(), "msg-2", "", "mp3"), null);
});

test("a highlighted selection is a different thing to read, so it starts over", () => {
  assert.equal(resumePoint(pausedAt(), "msg-1", "  кусок текста  ", "mp3"), null);
});

test("a remembered offset is not reused for a different audio format", () => {
  assert.equal(resumePoint(pausedAt(), "msg-1", "", "opus"), null);
});

test("nothing remembered means nothing to continue", () => {
  assert.equal(resumePoint(null, "msg-1", "", "mp3"), null);
});

test("a stale index outside the pieces starts over instead of throwing", () => {
  assert.equal(resumePoint(pausedAt({ index: 9 }), "msg-1", "", "mp3"), null);
  assert.equal(resumePoint(pausedAt({ index: -1 }), "msg-1", "", "mp3"), null);
});

test("a negative offset is clamped rather than seeking backwards", () => {
  assert.equal(resumePoint(pausedAt({ offset: -3 }), "msg-1", "", "mp3")?.offset, 0);
});

test("the first piece is short so the voice starts almost at once", () => {
  const sentence = "Это предложение занимает ровно сорок пять знаков. ";
  const chunks = splitForSpeech(sentence.repeat(60), CHUNK_SIZE_RAMP);
  assert.ok(chunks.length >= 4);
  assert.ok(
    chunks[0]!.length <= CHUNK_SIZE_RAMP[0]!,
    `first piece is ${chunks[0]!.length} characters`,
  );
  // Later pieces are allowed to grow: by then the voice is already speaking.
  assert.ok(chunks[3]!.length > CHUNK_SIZE_RAMP[0]!);
});

test("the ramp never lets a piece exceed what one host call can carry", () => {
  const chunks = splitForSpeech("Слово. ".repeat(2000), CHUNK_SIZE_RAMP);
  for (const chunk of chunks) assert.ok(chunk.length <= 1500);
});

test("a short message is still one piece under the ramp", () => {
  assert.deepEqual(splitForSpeech("Коротко.", CHUNK_SIZE_RAMP), ["Коротко."]);
});
