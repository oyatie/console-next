// SPDX-License-Identifier: LicenseRef-Proprietary
import type { KeyboardEvent } from "react";
import { expect, test, vi } from "vitest";
import type { ChartNode } from "../domain/model";
import { CHART_KEYS, useChartKeys } from "./use-chart-keys";
import type { ChartState } from "./use-chart-state";

function fixture() {
  const parent = { id: "parent", children: [] } as unknown as ChartNode;
  const node = { id: "node", parentId: parent.id, children: [parent] } as ChartNode;
  const next = { id: "next", parentId: parent.id, children: [] } as unknown as ChartNode;
  parent.children = [node, next];
  const c = {
    order: [parent, node, next], cursor: node.id, focus: parent, expanded: new Set([parent.id]),
    setByKeys: vi.fn(), setCursor: vi.fn(), select: vi.fn(), setSel: vi.fn(), toggle: vi.fn(), clear: vi.fn(),
  };
  const g = { add: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), focusOn: vi.fn(), open: vi.fn(), menu: vi.fn(), find: vi.fn(), order: vi.fn(() => vi.fn()) };
  const press = (key: string, code = "", modifiers = {}) => {
    const event = { key, code, target: { closest: () => null }, preventDefault: vi.fn(), ...modifiers } as unknown as KeyboardEvent;
    useChartKeys(c as unknown as ChartState, g)(event);
    return event;
  };
  return { c, g, node, next, parent, press };
}

test.each(CHART_KEYS.flatMap(([command, keys]) => keys.map(key => [command, key] as const)))("documented %s binding %s runs its handler", (command, chord) => {
  const { c, g, press } = fixture();
  const parts = chord.split(" ");
  const key = parts.at(-1)!;
  const event = press(key === "Space" ? " " : key, /^[AMF]$/.test(key) ? `Key${key}` : key, { ctrlKey: parts.includes("Ctrl"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift") });
  if (command === "clear") expect(c.clear).toHaveBeenCalledOnce();
  else expect(event.preventDefault).toHaveBeenCalledOnce();
  if (["add", "rename", "move", "open", "menu", "find"].includes(command)) expect(g[command as "add"]).toHaveBeenCalledOnce();
});

test("Home and End reach the first and last drawn nodes; context keys open the current unit menu", () => {
  const { c, g, node, parent, next, press } = fixture();
  press("Home");
  expect(c.setCursor).toHaveBeenLastCalledWith(parent.id);
  press("End");
  expect(c.setCursor).toHaveBeenLastCalledWith(next.id);
  press("F10", "F10", { shiftKey: true });
  press("ContextMenu");
  expect(g.menu.mock.calls).toEqual([[node], [node]]);
  press("F10");
  expect(g.menu).toHaveBeenCalledTimes(2);
});

test("selection, reorder, deletion aliases and Hangul physical keys keep their actions", () => {
  const { c, g, node, next, press } = fixture();
  press("ArrowDown", "ArrowDown", { shiftKey: true });
  expect(c.select).toHaveBeenLastCalledWith(next.id, "extend", true);
  press(" ", "Space", { metaKey: true });
  expect(c.select).toHaveBeenLastCalledWith(node.id, "toggle", true);
  press("ㅁ", "KeyA", { metaKey: true });
  expect(c.setSel).toHaveBeenLastCalledWith(new Set([node.id, next.id]));
  press("ArrowUp", "ArrowUp", { altKey: true });
  expect(g.order).toHaveBeenLastCalledWith(node, -1);
  for (const key of ["Delete", "Backspace"]) press(key);
  expect(g.remove.mock.calls).toEqual([[node], [node]]);
  press("ㅁ", "KeyA");
  expect(g.add).toHaveBeenLastCalledWith(node);
});

test("controls retain their own keys and unrelated modifier chords do nothing", () => {
  const { c, g, press } = fixture();
  const event = press("Home", "Home", { target: { closest: () => ({}) } });
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(c.setCursor).not.toHaveBeenCalled();
  press("ㅁ", "KeyA", { altKey: true });
  expect(g.add).not.toHaveBeenCalled();
});

test.each(["ArrowLeft", "ArrowRight", "Enter", "Delete", "Home", " ", "/"])("Alt+%s is left to the browser", (key) => {
  const { c, g, press } = fixture();
  const event = press(key, key, { altKey: true });
  expect(event.preventDefault).not.toHaveBeenCalled();
  for (const handler of [...Object.values(c), ...Object.values(g)].filter(vi.isMockFunction)) {
    expect(handler).not.toHaveBeenCalled();
  }
});

test.each([["ArrowUp", -1], ["ArrowDown", 1]] as const)("Shift+Alt+%s reorders without extending selection", (key, direction) => {
  const { c, g, node, press } = fixture();
  const event = press(key, key, { shiftKey: true, altKey: true });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(g.order).toHaveBeenCalledExactlyOnceWith(node, direction);
  expect(g.order.mock.results[0]!.value).toHaveBeenCalledOnce();
  expect(c.select).not.toHaveBeenCalled();
  expect(c.setCursor).not.toHaveBeenCalled();
});

test.each([
  ["Enter", "Enter", { shiftKey: true }, "open"],
  [" ", "Space", { shiftKey: true }, "expand"],
  ["Delete", "Delete", { shiftKey: true }, "end"],
  ["ArrowDown", "ArrowDown", { ctrlKey: true }, "down"],
  ["ArrowRight", "ArrowRight", { metaKey: true }, "right"],
  ["/", "Digit7", { shiftKey: true }, "find"],
] as const)("modified %s keeps its %s action", (key, code, modifiers, command) => {
  const { c, g, node, next, press } = fixture();
  const event = press(key, code, modifiers);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  if (command === "open") expect(g.open).toHaveBeenCalledExactlyOnceWith(node);
  if (command === "expand") expect(c.toggle).toHaveBeenCalledExactlyOnceWith(node.id);
  if (command === "end") expect(g.remove).toHaveBeenCalledExactlyOnceWith(node);
  if (command === "down") expect(c.setCursor).toHaveBeenLastCalledWith(next.id);
  if (command === "right") expect(c.toggle).toHaveBeenLastCalledWith(node.id, true);
  if (command === "find") expect(g.find).toHaveBeenCalledOnce();
});

test.each(["A", "M", "F"])("Shift+%s retains its physical letter action", (key) => {
  const { g, node, press } = fixture();
  const action = { A: g.add, M: g.move, F: g.focusOn }[key]!;
  press(key, `Key${key}`, { shiftKey: true });
  expect(action).toHaveBeenCalledExactlyOnceWith(node);
});

test.each(["Digit7", "KeyQ"])("slash uses the produced character from %s", (code) => {
  const { g, press } = fixture();
  press("/", code, { shiftKey: true });
  expect(g.find).toHaveBeenCalledOnce();
});
