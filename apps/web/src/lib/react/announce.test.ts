import { afterEach, expect, test, vi } from "vitest";
import { useEffect } from "react";
import { focusSoon, useRoutePresentation } from "./announce";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: vi.fn() }));

// A page with a heading, an optional open dialog, and a frame clock; `focused` records who has focus.
function page() {
  let queue: FrameRequestCallback[] = [];
  const state = { focused: "", dialog: false, inMain: false };
  const input = new EventTarget();
  const heading = { id: "history", textContent: "People", focus: () => (state.focused = "heading") };
  vi.stubGlobal("document", {
    addEventListener: input.addEventListener.bind(input),
    removeEventListener: input.removeEventListener.bind(input),
    getElementById: (id: string) => (id === "history" ? heading : null),
    querySelectorAll: () => (state.dialog ? [{ contains: () => false }] : []),
    querySelector: (selector: string) => selector.includes("h1") ? heading : null,
    activeElement: { closest: (selector: string) => selector === "main" && state.inMain ? {} : null },
  });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  const frame = () => {
    const run = queue;
    queue = [];
    run.forEach((cb) => cb(0));
  };
  return { state, frame, input, later: (cb: FrameRequestCallback) => queue.push(cb) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function present(pathname: string) {
  useRoutePresentation(pathname, true);
  return vi.mocked(useEffect).mock.calls.at(-1)![0]();
}

for (const restoreFrame of [0, 1, 2]) {
  test(`route heading yields to focus restored inside main after ${restoreFrame} frames`, () => {
    const { state, frame } = page();
    const cleanup = present(`/restored-${restoreFrame}`);
    for (let i = 0; i < restoreFrame; i++) frame();
    state.focused = "row";
    state.inMain = true;
    for (let i = restoreFrame; i < 4; i++) frame();
    expect(state.focused).toBe("row");
    cleanup?.();
  });
}

test.each(["body", "nav link"])("route heading takes focus when it was left on %s outside main", (focused) => {
  const { state, frame } = page();
  state.focused = focused;
  const cleanup = present(`/outside-${focused}`);
  frame();
  frame();
  frame();
  expect(state.focused).toBe("heading");
  cleanup?.();
});

test("route heading checks current focus again even when main held it at scheduling", () => {
  const { state, frame } = page();
  state.inMain = true;
  const cleanup = present("/focus-left-main");
  frame();
  state.inMain = false;
  state.focused = "nav link";
  frame();
  frame();
  expect(state.focused).toBe("heading");
  cleanup?.();
});

test("an explicit command landmark still takes focus from another element inside main", () => {
  const { state, frame } = page();
  state.focused = "trigger";
  state.inMain = true;
  focusSoon("history");
  frame();
  frame();
  expect(state.focused).toBe("heading");
});

test("with no dialog the landmark gets focus on the second frame", () => {
  const { state, frame } = page();
  focusSoon("gone", "history");
  frame();
  expect(state.focused).toBe("");
  frame();
  expect(state.focused).toBe("heading");
});

test("a dialog that unmounts late does not win: its focus restore runs first, the landmark last", () => {
  const { state, frame, later } = page();
  state.dialog = true;
  focusSoon("history");
  frame();
  frame();
  frame();
  expect(state.focused).toBe("");
  // The dialog unmounts between frames; React Aria queues its restore to the trigger for the next frame.
  state.dialog = false;
  later(() => (state.focused = "trigger"));
  frame();
  frame();
  expect(state.focused).toBe("heading");
});

test("a dialog that stays open keeps focus inside it: the call gives up", () => {
  const { state, frame } = page();
  state.dialog = true;
  focusSoon("history");
  for (let i = 0; i < 100; i++) frame();
  expect(state.focused).toBe("");
});

test("a target still rendering is waited for (a tab a navigation opens), not given up after two quiet frames", () => {
  let queue: FrameRequestCallback[] = [];
  let rendered = false;
  const state = { focused: "" };
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getElementById: (id: string) => (rendered && id === "ev-1" ? { focus: () => (state.focused = "row") } : null),
    querySelectorAll: () => [],
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  const frame = () => {
    const run = queue;
    queue = [];
    run.forEach((cb) => cb(0));
  };
  focusSoon("ev-1", "history");
  for (let i = 0; i < 5; i++) frame();
  expect(state.focused).toBe("");
  rendered = true;
  frame();
  expect(state.focused).toBe("row");
});

for (const type of ["pointerdown", "keydown"]) {
  test(`a delayed dialog focus restore yields to the user's next ${type}`, () => {
    const { state, frame, input } = page();
    state.dialog = true;
    focusSoon("history");
    frame();
    state.dialog = false;
    frame();
    input.dispatchEvent(new Event(type));
    state.focused = "chosen-box";
    frame();
    expect(state.focused).toBe("chosen-box");
  });
}
