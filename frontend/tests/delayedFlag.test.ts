import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function mountDelayedFlag(delay = 180, minimum = 280) {
  let visible = false;
  let initialized = false;
  let latestActive = false;
  let now = 1000;
  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const ref = { current: 0 };
  let effectCleanup: (() => void) | undefined;

  const source = ts.transpileModule(
    readFileSync(new URL("../src/useDelayedFlag.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  const exports: Record<string, unknown> = {};
  const hook = () =>
    (exports.useDelayedFlag as (active: boolean, d?: number, m?: number) => boolean)(
      latestActive,
      delay,
      minimum,
    );

  const reactMock = {
    useState: (initial: boolean) => {
      if (!initialized) {
        visible = initial;
        initialized = true;
      }
      return [
        visible,
        (next: boolean) => {
          visible = next;
          hook();
        },
      ];
    },
    useRef: () => ref,
    useEffect: (fn: () => void | (() => void)) => {
      effectCleanup?.();
      effectCleanup = fn() || undefined;
    },
  };

  runInNewContext(source, {
    exports,
    require: (name: string) => {
      assert.equal(name, "react");
      return reactMock;
    },
    Date: { now: () => now },
    Math,
    window: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimerId++;
        timers.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
      },
    },
  });

  const render = (active: boolean) => {
    latestActive = active;
    return hook();
  };
  const advance = (ms: number) => {
    const target = now + ms;
    while (true) {
      let earliest: { id: number; at: number; fn: () => void } | null = null;
      for (const [id, item] of timers) {
        if (item.at <= target && (!earliest || item.at < earliest.at)) {
          earliest = { id, ...item };
        }
      }
      if (!earliest) break;
      now = earliest.at;
      timers.delete(earliest.id);
      earliest.fn();
    }
    now = target;
  };

  return { render, advance, isVisible: () => visible };
}

test("fast local folder navigation (< 180ms) never flashes loading UI", () => {
  const harness = mountDelayedFlag(180, 280);
  assert.equal(harness.render(true), false);
  harness.advance(120);
  assert.equal(harness.isVisible(), false);
  assert.equal(harness.render(false), false);
  harness.advance(500);
  assert.equal(harness.isVisible(), false);
});

test("slow network folder navigation shows indicator after 180ms and holds >= 280ms without blinking", () => {
  const harness = mountDelayedFlag(180, 280);
  assert.equal(harness.render(true), false);
  harness.advance(180);
  assert.equal(harness.isVisible(), true);
  assert.equal(harness.render(true), true);

  harness.advance(50);
  assert.equal(harness.render(false), true);
  harness.advance(200);
  assert.equal(harness.isVisible(), true);
  harness.advance(30);
  assert.equal(harness.isVisible(), false);
});
