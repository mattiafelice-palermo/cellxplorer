import assert from "node:assert/strict";
import test from "node:test";
import { captureTimeCapacityRefinement } from "../src/features/analyses/editor/families/time-capacity/timeCapacityRefinementReveal.ts";
const layout = { xaxis: { range: [0, 1] }, yaxis: { range: [0, 1] } };

test("reduced motion skips capture without touching the plotted figure", () => {
  assert.equal(captureTimeCapacityRefinement({} as HTMLElement, true), null);
});

test("SVG and oversized surfaces use immediate replacement", () => {
  assert.equal(captureTimeCapacityRefinement({ _fullLayout: layout, querySelector: () => ({}) } as never, false), null);
  const source = { parentElement: {}, width: 4096, height: 4096, animate() {} };
  assert.equal(captureTimeCapacityRefinement({ _fullLayout: layout, querySelector: () => null,
    querySelectorAll: () => [source] } as never, false), null);
});

test("crossfade copies the existing frame once, animates no coordinates, and cancels cleanly", () => {
  const previousDocument = globalThis.document;
  const frames: unknown[] = [];
  let copies = 0;
  let cancelled = 0;
  let removed = 0;
  let appended = 0;
  const animate = (keyframes: unknown, options: unknown) => {
    frames.push({ keyframes, options });
    return { cancel() { cancelled += 1; }, finished: new Promise(() => {}) };
  };
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const overlay = { width: 0, height: 0, style: { cssText: "", pointerEvents: "" },
    setAttribute() {}, getContext: () => ({ drawImage() { copies += 1; } }),
    remove() { removed += 1; }, animate };
  const source = { width: 100, height: 100, style: { cssText: "position:absolute" },
    parentElement: { appendChild() { appended += 1; } }, getBoundingClientRect: () => rect, animate };
  globalThis.document = { createElement: () => overlay } as never;
  try {
    const graph = { _fullLayout: layout, querySelector: () => null, querySelectorAll: () => [source], contains: () => true };
    const transition = captureTimeCapacityRefinement(graph as never, false);
    assert.ok(transition);
    assert.equal(copies, 1);
    assert.equal(appended, 0);
    transition.reveal();
    assert.equal(appended, 1);
    assert.deepEqual(frames, [
      { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 220, easing: "ease-out" } },
      { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 220, easing: "ease-out" } },
    ]);
    transition.cancel();
    transition.cancel();
    assert.equal(cancelled, 2);
    assert.equal(removed, 1);
    assert.equal(overlay.width, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
