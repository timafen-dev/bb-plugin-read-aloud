import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { speakableText } from "../text.ts";
import { ReadingSession } from "../reading-session.ts";
import {
  activatePlayback,
  ChunkPlayback,
  disposePlayback,
} from "../playback.ts";
const ts = createRequire(import.meta.url)(
  "typescript",
) as typeof import("typescript");

test("microphone invalidates an in-flight prepare and clears its pending indicator", async (t) => {
  const dom = new JSDOM(
    '<div data-message-column><div class="relative w-full"><div class="absolute top-0"><button aria-label="Read aloud">Play</button></div></div></div>',
  );
  let release!: (r: Response) => void;
  let started = 0;
  let mic = false;
  const cleanups: Array<() => void> = [];
  const media = {
    getUserMedia: async (_constraints?: unknown) => {
      mic = true;
      return {};
    },
  };
  class FakeSession {
    subscribe() {
      return () => {};
    }
    snapshot() {
      return { state: "paused", position: 0, duration: 1, approximate: true };
    }
    play() {
      started++;
    }
    pause() {}
    dispose() {}
  }
  const modules: Record<string, unknown> = {
    react: {},
    "react/jsx-runtime": {},
    "@get-bb/plugin-sdk/app": { definePluginApp: (fn: unknown) => fn },
    sonner: { toast: { error() {} } },
    "./text.ts": { speakableText },
    "./reading-session.ts": { ReadingSession: FakeSession },
    "./chunk-client.ts": {
      ChunkClient: class {
        dispose() {}
      },
    },
    "./player-view.ts": {
      mountPlayer: () => ({
        element: dom.window.document.createElement("div"),
        dispose() {},
        move() {},
      }),
    },
    "./playback.ts": {
      activatePlayback() {},
      disposePlayback() {},
      decodePlayback() {},
      ChunkPlayback: class {},
    },
  };
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(
    await readFile(new URL("../app.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (!(name in modules)) throw Error("Unexpected import " + name);
      return modules[name];
    },
    document: dom.window.document,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    navigator: { mediaDevices: media },
    setTimeout,
    clearTimeout,
    AbortSignal,
    DOMException,
    Uint8Array,
    atob,
    Date,
    fetch: async () => new Promise<Response>((r) => (release = r)),
  });
  let action!: { run(input: unknown): Promise<void> };
  (exports.default as (app: unknown) => void)({
    slots: {
      messageAction: (a: typeof action) => {
        action = a;
      },
      settingsSection() {},
    },
    contentScripts: {
      register: (c: { mount(): () => void }) => cleanups.push(c.mount()),
    },
  });
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    dom.window.close();
  });
  const button = dom.window.document.querySelector("button")!;
  button.click();
  const running = action.run({
    threadId: "qa",
    message: { id: "qa", text: "Проверка." },
    selectedText: null,
  });
  await tick();
  await media.getUserMedia({ audio: true });
  release(new Response(JSON.stringify({ chunks: ["Проверка."] })));
  await running;
  assert.equal(mic, true);
  assert.equal(
    started,
    0,
    "stale prepare must not start speech over the microphone",
  );
  assert.equal(button.hasAttribute("data-read-aloud-playing"), false);
});

class FakeContext {
  state = "running";
  currentTime = 0;
  destination = {};
  sources = 0;
  resume: () => Promise<void> = async () => {
    this.state = "running";
  };
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  createBufferSource() {
    this.sources++;
    return {
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    };
  }
}
Object.defineProperty(globalThis, "AudioContext", {
  value: FakeContext,
  writable: true,
  configurable: true,
});
function realSession(clock: FakeContext) {
  return new ReadingSession(["текст"], {
    synthesize: async () => ({
      audioBase64: "fixture",
      mimeType: "audio/mpeg",
      cached: false,
    }),
    decode: async () => ({ duration: 30 }) as AudioBuffer,
    createPlayback: () => {
      const p = new ChunkPlayback();
      return {
        get currentTime() {
          return p.currentTime;
        },
        stop: () => p.stop(),
        play: (b, o) => p.playBuffer(b, o),
      };
    },
  });
}
test("a rejected browser activation preserves the requested resume offset", async (t) => {
  const clock = new FakeContext();
  t.mock.method(globalThis, "AudioContext", function () {
    return clock;
  } as unknown as typeof AudioContext);
  const session = realSession(clock);
  t.after(() => {
    session.dispose();
    disposePlayback();
  });
  activatePlayback();
  session.play();
  await tick();
  session.pause();
  session.seek(12);
  clock.state = "suspended";
  clock.resume = () => Promise.reject(Error("resume failed"));
  activatePlayback();
  session.play();
  await tick();
  assert.equal(session.snapshot().state, "error");
  assert.equal(session.snapshot().position, 12);
});
test("pause while browser activation is pending retains offset and prevents late audio", async (t) => {
  const clock = new FakeContext();
  t.mock.method(globalThis, "AudioContext", function () {
    return clock;
  } as unknown as typeof AudioContext);
  const session = realSession(clock);
  t.after(() => {
    session.dispose();
    disposePlayback();
  });
  activatePlayback();
  session.play();
  await tick();
  session.pause();
  session.seek(12);
  let release!: () => void;
  clock.state = "suspended";
  clock.resume = () => new Promise<void>((r) => (release = r));
  activatePlayback();
  session.play();
  await tick();
  session.pause();
  assert.equal(session.snapshot().position, 12);
  clock.state = "running";
  release();
  await tick();
  assert.equal(clock.sources, 1);
});
