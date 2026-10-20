import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ReadingSession, type PlaybackHandle } from "../reading-session.ts";
import type { ChunkAudio } from "../speech-jobs.ts";
const chunk = (i: number): ChunkAudio => ({
  audioBase64: String(i),
  mimeType: "audio/mpeg",
  cached: false,
});
function setup(custom?: (i: number, retry: boolean) => Promise<ChunkAudio>) {
  const calls: number[] = [];
  const played: Array<{
    id: number;
    offset: number;
    finish: () => void;
    time: number;
    stopped: boolean;
  }> = [];
  const session = new ReadingSession(
    ["а".repeat(120), "б".repeat(120), "в".repeat(120)],
    {
      synthesize: async (i, retry) => {
        calls.push(i);
        return custom ? custom(i, retry) : chunk(i);
      },
      decode: async (a) =>
        ({
          duration: [10, 20, 30][Number(a.audioBase64)]!,
          tag: Number(a.audioBase64),
        }) as AudioBuffer,
      createPlayback: () => {
        let entry: (typeof played)[number];
        return {
          get currentTime() {
            return entry?.time ?? 0;
          },
          stop() {
            if (entry) {
              entry.stopped = true;
              entry.finish();
            }
          },
          play: async (buffer, offset) => {
            await new Promise<void>((resolve) => {
              entry = {
                id: (buffer as AudioBuffer & { tag: number }).tag,
                offset,
                finish: resolve,
                time: offset,
                stopped: false,
              };
              played.push(entry);
            });
          },
        } satisfies PlaybackHandle;
      },
    },
  );
  return { session, calls, played };
}
const settle = async () => {
  await tick();
  await tick();
};

test("pause and resume reuse identical audio and exact offset without new synthesis", async () => {
  const { session, calls, played } = setup();
  session.play();
  await settle();
  played[0]!.time = 4;
  session.pause();
  assert.equal(session.snapshot().position, 4);
  session.play();
  await settle();
  assert.equal(played[1]!.id, 0);
  assert.equal(played[1]!.offset, 4);
  assert.equal(calls.filter((i) => i === 0).length, 1);
  session.dispose();
});

test("late prefetch failure preserves prior audio and resumes at zero in the failed chunk", async () => {
  let failed = false;
  const { session, calls, played } = setup(async (i, retry) => {
    if (i === 1 && !failed) {
      failed = true;
      throw Error("network timeout");
    }
    assert.ok(i !== 1 || retry);
    return chunk(i);
  });
  session.play();
  await settle();
  played[0]!.time = 10;
  played[0]!.finish();
  await settle();
  assert.equal(session.snapshot().state, "error");
  assert.equal(session.snapshot().index, 1);
  assert.equal(session.snapshot().position, 10);
  session.play();
  await settle();
  assert.equal(played[1]!.id, 1);
  assert.equal(played[1]!.offset, 0);
  assert.equal(calls.filter((i) => i === 0).length, 1);
  session.dispose();
});

test("pausing while waiting never applies the previous fragment duration to its successor", async () => {
  let ready!: (a: ChunkAudio) => void;
  const { session, played } = setup((i) =>
    i === 1 ? new Promise((r) => (ready = r)) : Promise.resolve(chunk(i)),
  );
  session.play();
  await settle();
  played[0]!.time = 10;
  played[0]!.finish();
  await settle();
  session.pause();
  ready(chunk(1));
  await settle();
  session.play();
  await settle();
  assert.equal(played[1]!.id, 1);
  assert.equal(played[1]!.offset, 0);
  session.dispose();
});

test("seeking to unavailable audio buffers and seeking away prevents stale playback", async () => {
  let ready!: (a: ChunkAudio) => void;
  const { session, played, calls } = setup((i) =>
    i === 2 ? new Promise((r) => (ready = r)) : Promise.resolve(chunk(i)),
  );
  session.play();
  await settle();
  session.seek(35);
  await settle();
  assert.equal(session.snapshot().state, "buffering");
  assert.equal(session.snapshot().index, 2);
  session.seek(2);
  await settle();
  ready(chunk(2));
  await settle();
  assert.equal(played.at(-1)!.id, 0);
  assert.equal(played.at(-1)!.offset, 2);
  assert.equal(calls.filter((i) => i === 0).length, 1);
  session.dispose();
});

test("explicit seek into a failed fragment retries it without discarding earlier audio", async () => {
  let failed = false;
  const { session, played, calls } = setup(async (i, retry) => {
    if (i === 1 && !failed) {
      failed = true;
      throw Error("network timeout");
    }
    return chunk(i);
  });
  session.play();
  await settle();
  played[0]!.finish();
  await settle();
  assert.equal(session.snapshot().state, "error");
  session.seek(12);
  session.play();
  await settle();
  assert.equal(session.snapshot().state, "playing");
  assert.equal(played.at(-1)!.id, 1);
  assert.equal(calls.filter((i) => i === 0).length, 1);
  session.dispose();
});

test("pause during initial synthesis never starts audio later", async () => {
  let ready!: (a: ChunkAudio) => void;
  const { session, played } = setup((i) => new Promise((r) => (ready = r)));
  session.play();
  await settle();
  session.pause();
  ready(chunk(0));
  await settle();
  assert.equal(played.length, 0);
  assert.equal(session.snapshot().state, "paused");
  session.dispose();
});

test("full duration becomes exact, skip clamps, and replay uses the original rendition", async () => {
  const { session, played, calls } = setup();
  session.play();
  await settle();
  for (let i = 0; i < 3; i++) {
    played.at(-1)!.finish();
    await settle();
  }
  assert.equal(session.snapshot().state, "ended");
  assert.equal(session.snapshot().duration, 60);
  assert.equal(session.snapshot().approximate, false);
  session.seek(25);
  assert.equal(session.snapshot().position, 25);
  session.skip(-15);
  assert.equal(session.snapshot().position, 10);
  session.skip(-100);
  assert.equal(session.snapshot().position, 0);
  session.skip(1000);
  assert.equal(session.snapshot().position, 60);
  session.seek(5);
  session.play();
  await settle();
  assert.equal(played.at(-1)!.id, 0);
  assert.equal(played.at(-1)!.offset, 5);
  assert.deepEqual(calls, [0, 1, 2]);
  session.dispose();
});
