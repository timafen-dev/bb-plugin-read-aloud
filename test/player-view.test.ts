import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { ReadingSession } from "../reading-session.ts";
import { mountPlayer } from "../player-view.ts";

test("real DOM controls pause, seek, skip and keep the player outside the absolute action toolbar", async (t) => {
  const dom = new JSDOM(
    '<main><div id="slot"><div style="position:absolute"><button>Play</button></div></div><div id="next">next</div></main>',
  );
  const anchor = dom.window.document.querySelector("#slot")! as HTMLElement;
  const session = new ReadingSession(["а".repeat(120), "б".repeat(120)], {
    synthesize: async (i) => ({
      audioBase64: String(i),
      mimeType: "audio/mpeg",
      cached: false,
    }),
    decode: async () => ({ duration: 30 }) as AudioBuffer,
    createPlayback: () => ({
      currentTime: 0,
      play: async () => new Promise(() => {}),
      stop() {},
    }),
  });
  let activated = 0;
  const view = mountPlayer(anchor, session, { activate: () => activated++ });
  t.after(() => {
    view.dispose();
    session.dispose();
    dom.window.close();
  });
  assert.equal(anchor.nextElementSibling, view.element);
  assert.ok(!anchor.contains(view.element));
  assert.ok(view.element.textContent!.includes("≈"));
  const button = () =>
    view.element.querySelector(
      'button[data-action="toggle"]',
    )! as HTMLButtonElement;
  button().click();
  await tick();
  assert.equal(session.snapshot().state, "playing");
  assert.equal(button().getAttribute("aria-label"), "Пауза");
  button().click();
  assert.equal(session.snapshot().state, "paused");
  const range = view.element.querySelector(
    'input[type="range"]',
  )! as HTMLInputElement;
  range.value = "20";
  range.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(session.snapshot().position, 20);
  (
    view.element.querySelector('[data-action="back"]')! as HTMLButtonElement
  ).click();
  assert.equal(session.snapshot().position, 5);
  (
    view.element.querySelector('[data-action="forward"]')! as HTMLButtonElement
  ).click();
  assert.equal(session.snapshot().position, 20);
  assert.ok(activated >= 4);
  view.dispose();
  assert.equal(
    dom.window.document.querySelector("[data-read-aloud-player]"),
    null,
  );
});

test("the retained panel offers Continue here after synthesis failure and does not discard its slider", async (t) => {
  const dom = new JSDOM('<div id="anchor"></div>');
  let fail = true;
  const session = new ReadingSession(["проверка"], {
    synthesize: async () => {
      if (fail) throw Error("provider timed out");
      return { audioBase64: "ok", mimeType: "audio/mpeg", cached: false };
    },
    decode: async () => ({ duration: 10 }) as AudioBuffer,
    createPlayback: () => ({
      currentTime: 0,
      play: async () => new Promise(() => {}),
      stop() {},
    }),
  });
  const view = mountPlayer(
    dom.window.document.querySelector("#anchor")! as HTMLElement,
    session,
  );
  t.after(() => {
    view.dispose();
    session.dispose();
    dom.window.close();
  });
  (
    view.element.querySelector('[data-action="toggle"]')! as HTMLButtonElement
  ).click();
  await tick();
  assert.equal(session.snapshot().state, "error");
  assert.match(view.element.textContent!, /Продолжить отсюда/);
  assert.ok(view.element.querySelector('input[type="range"]'));
  fail = false;
  (
    view.element.querySelector('[data-action="toggle"]')! as HTMLButtonElement
  ).click();
  await tick();
  assert.equal(session.snapshot().state, "playing");
});
