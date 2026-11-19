// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { isImeKey } from "./ime";

test("the input method owns a key pressed while composing, the Enter that ends a composition, and a Process key", () => {
  // A native listener reads isComposing on the event; a React handler reads it on nativeEvent.
  expect(isImeKey({ key: "Enter", isComposing: true })).toBe(true);
  expect(isImeKey({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
  // Safari ends the composition before the keydown, so only the key code marks that Enter.
  expect(isImeKey({ key: "Enter", keyCode: 229, isComposing: false })).toBe(true);
  expect(isImeKey({ key: "Process" })).toBe(true);
  expect(isImeKey({ key: "Enter", keyCode: 13, isComposing: false, nativeEvent: { isComposing: false } })).toBe(false);
});
