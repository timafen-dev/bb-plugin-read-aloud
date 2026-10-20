import type { ReadingSession } from "./reading-session.ts";
export interface PlayerView {
  element: HTMLElement;
  move(anchor: HTMLElement): void;
  dispose(): void;
}
const time = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export function mountPlayer(
  anchor: HTMLElement,
  session: ReadingSession,
  options: { activate?: () => void } = {},
): PlayerView {
  const doc = anchor.ownerDocument;
  const root = doc.createElement("section");
  root.dataset.readAloudPlayer = "";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Озвучка сообщения");
  root.style.cssText =
    "box-sizing:border-box;width:100%;min-width:0;margin:8px 0;padding:10px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent);font:inherit;";
  const controls = doc.createElement("div");
  controls.style.cssText =
    "display:flex;flex-wrap:wrap;align-items:center;gap:6px;";
  const button = (action: string, label: string) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.dataset.action = action;
    b.setAttribute("aria-label", label);
    b.style.cssText =
      "font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;min-width:44px;min-height:44px;padding:6px 10px;cursor:pointer;touch-action:manipulation;";
    return b;
  };
  const back = button("back", "Назад на 15 секунд");
  back.textContent = "−15 с";
  const toggle = button("toggle", "Воспроизвести");
  toggle.textContent = "▶";
  const forward = button("forward", "Вперёд на 15 секунд");
  forward.textContent = "+15 с";
  const counter = doc.createElement("span");
  counter.style.cssText =
    "font-size:12px;font-variant-numeric:tabular-nums;margin-left:auto;white-space:nowrap";
  controls.append(back, toggle, forward, counter);
  const range = doc.createElement("input");
  range.type = "range";
  range.min = "0";
  range.step = "0.1";
  range.setAttribute("aria-label", "Позиция озвучки");
  range.style.cssText =
    "display:block;box-sizing:border-box;width:100%;height:32px;margin:6px 0;accent-color:var(--primary,currentColor);";
  const status = doc.createElement("div");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.cssText = "font-size:12px;overflow-wrap:anywhere;";
  root.append(controls, range, status);
  anchor.insertAdjacentElement("afterend", root);
  let dragging = false,
    disposed = false;
  const render = () => {
    if (disposed) return;
    const s = session.snapshot();
    range.max = String(s.duration);
    if (!dragging) range.value = String(s.position);
    counter.textContent = `${time(dragging ? Number(range.value) : s.position)} / ${s.approximate ? "≈" : ""}${time(s.duration)}`;
    const running = s.state === "playing" || s.state === "buffering";
    const label =
      s.state === "error"
        ? "Продолжить отсюда"
        : running
          ? "Пауза"
          : s.state === "ended"
            ? "Воспроизвести заново"
            : "Продолжить";
    toggle.setAttribute("aria-label", label);
    toggle.textContent = s.state === "error" ? label : running ? "Ⅱ" : "▶";
    status.textContent =
      s.state === "buffering"
        ? "Подготавливаю аудио…"
        : s.state === "error"
          ? `${s.error ?? "Сбой озвучки"}. Аудио и позиция сохранены.`
          : s.state === "playing"
            ? "Воспроизведение"
            : s.state === "ended"
              ? "Прочитано до конца"
              : "На паузе";
    range.setAttribute(
      "aria-valuetext",
      `${time(s.position)} из ${s.approximate ? "примерно " : ""}${time(s.duration)}`,
    );
  };
  const activate = () => options.activate?.();
  toggle.addEventListener("click", () => {
    activate();
    const state = session.snapshot().state;
    if (state === "playing" || state === "buffering") session.pause();
    else session.play();
  });
  back.addEventListener("click", () => {
    activate();
    session.skip(-15);
  });
  forward.addEventListener("click", () => {
    activate();
    session.skip(15);
  });
  range.addEventListener("input", () => {
    dragging = true;
    render();
  });
  range.addEventListener("change", () => {
    activate();
    dragging = false;
    session.seek(Number(range.value));
    render();
  });
  const unsubscribe = session.subscribe(render);
  const interval = setInterval(render, 250);
  render();
  return {
    element: root,
    move(next) {
      if (!disposed && next.nextElementSibling !== root)
        next.insertAdjacentElement("afterend", root);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      unsubscribe();
      root.remove();
    },
  };
}
