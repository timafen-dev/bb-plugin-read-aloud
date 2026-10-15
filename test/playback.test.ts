import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { activatePlayback, ChunkPlayback, disposePlayback } from "../playback.ts";

let created: FakeContext[] = [];
class FakeSource {
  buffer: unknown;
  onended: (() => void) | null = null;
  stopped = false;
  disconnected = false;
  offset = -1;
  connect() {}
  disconnect() { this.disconnected = true; }
  start(_when: number, offset: number) { this.offset = offset; }
  stop() { this.stopped = true; }
}
class FakeContext {
  state = "suspended";
  currentTime = 10;
  destination = {};
  resumes = 0;
  sources: FakeSource[] = [];
  decode: () => Promise<{duration: number}> = async () => ({duration: 5});
  constructor() { created.push(this); }
  resume() { this.resumes++; this.state = "running"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  decodeAudioData() { return this.decode(); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
}
Object.assign(globalThis, { AudioContext: FakeContext });
afterEach(() => { disposePlayback(); created = []; });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("activation resumes before any async synthesis and reuses the context", () => {
  activatePlayback();
  assert.equal(created[0]!.resumes, 1);
  assert.equal(created[0]!.state, "running");
  activatePlayback();
  assert.equal(created.length, 1);
});

test("stopping settles playback and retains a resumable chunk offset", async () => {
  activatePlayback();
  const player = new ChunkPlayback();
  const playing = player.play(new Uint8Array([1]), 1.25);
  await tick();
  const clock = created[0]!;
  clock.currentTime = 11;
  assert.equal(player.currentTime, 2.25);
  assert.equal(clock.sources[0]!.offset, 1.25);
  player.stop();
  await playing;
  assert.ok(clock.sources[0]!.stopped);
  assert.ok(clock.sources[0]!.disconnected);
});

test("cancel during decode never starts late audio", async () => {
  activatePlayback();
  let decodeDone!: (b: {duration: number}) => void;
  created[0]!.decode = () => new Promise(r => { decodeDone = r; });
  const player = new ChunkPlayback();
  const playing = player.play(new Uint8Array([1]));
  await tick();
  player.stop();
  decodeDone({duration: 5});
  await playing;
  assert.equal(created[0]!.sources.length, 0);
});

test("natural completion settles and disconnects a chunk", async () => {
  activatePlayback();
  const player = new ChunkPlayback();
  const playing = player.play(new Uint8Array([1]));
  await tick();
  const source = created[0]!.sources[0]!;
  source.onended!();
  await playing;
  assert.ok(source.disconnected);
});

test("disposal closes the old context and next gesture can start afresh", () => {
  activatePlayback();
  const old = created[0]!;
  disposePlayback();
  assert.equal(old.state, "closed");
  activatePlayback();
  assert.equal(created.length, 2);
  assert.equal(created[1]!.state, "running");
});
