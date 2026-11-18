// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { isImeKey, leaveImeKey } from "./ime";

test("the input method owns a key pressed while composing, the Enter that ends a composition, and a Process key", () => {
  // A native listener reads isComposing on the event; a React handler reads it on nativeEvent.
  expect(isImeKey({ key: "Enter", isComposing: true })).toBe(true);
  expect(isImeKey({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
  // Safari ends the composition before the keydown, so only the key code marks that Enter.
  expect(isImeKey({ key: "Enter", keyCode: 229, isComposing: false })).toBe(true);
  expect(isImeKey({ key: "Process" })).toBe(true);
  expect(isImeKey({ key: "Enter", keyCode: 13, isComposing: false, nativeEvent: { isComposing: false } })).toBe(false);
});

test("an Escape or Tab the input method owns stops at the field; its Enter and a plain Escape or Tab go on", () => {
  const prevented: string[] = [];
  const stopped = (e: { key: string; keyCode?: number; isComposing?: boolean }) => {
    let hit = false;
    leaveImeKey({ ...e, stopPropagation: () => { hit = true; }, preventDefault: () => prevented.push(e.key) });
    return hit;
  };
  expect(["Escape", "Tab"].flatMap(key => [stopped({ key, isComposing: true }), stopped({ key, keyCode: 229 })])).toEqual([true, true, true, true]);
  // A composing Enter is not this handler's: the text input stops that one itself.
  expect([stopped({ key: "Enter", isComposing: true }), stopped({ key: "Escape", keyCode: 27 }), stopped({ key: "Tab", keyCode: 9 })]).toEqual([false, false, false]);
  // Only the Escape loses its default action (a search box clears on it); the Tab still commits the syllable and moves on.
  expect(prevented).toEqual(["Escape", "Escape"]);
});
