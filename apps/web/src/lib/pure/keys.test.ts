// SPDX-License-Identifier: LicenseRef-Proprietary
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { KEYMAP, conflicts, matches, pick, type KeyEventLike } from "./keys";

const press = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const free = { typing: false, dialog: false, inRegion: false };

test("letters match the physical key, so a Korean input mode still works", () => {
  expect(matches(press("ㅓ", "KeyJ"), "j")).toBe(true);
  expect(matches(press("j", "KeyJ"), "j")).toBe(true);
  expect(matches(press("J", "KeyJ", { shiftKey: true }), "j")).toBe(false);
  expect(matches(press("ㅏ", "KeyK", { metaKey: true }), "Mod+k")).toBe(true);
  expect(matches(press("k", "KeyK", { ctrlKey: true }), "Mod+k")).toBe(true);
  expect(matches(press("k", "KeyK"), "Mod+k")).toBe(false);
  expect(matches(press("j", "KeyJ", { altKey: true }), "j")).toBe(false);
});

test("digits match the key row and the number pad, not their shifted characters", () => {
  expect(matches(press("1", "Digit1"), "1")).toBe(true);
  expect(matches(press("1", "Numpad1"), "1")).toBe(true);
  expect(matches(press("!", "Digit1", { shiftKey: true }), "1")).toBe(false);
});

test("a shifted character matches by itself; named keys tell Shift apart", () => {
  expect(matches(press("?", "Slash", { shiftKey: true }), "?")).toBe(true);
  expect(matches(press("?", "Slash"), "?")).toBe(true);
  expect(matches(press("/", "Slash"), "?")).toBe(false);
  expect(matches(press("Enter", "Enter", { metaKey: true }), "Mod+Enter")).toBe(true);
  expect(matches(press("Enter", "Enter", { metaKey: true, shiftKey: true }), "Mod+Enter")).toBe(false);
  expect(matches(press("Enter", "Enter", { ctrlKey: true, shiftKey: true }), "Mod+Shift+Enter")).toBe(true);
});

test("a field keeps its keys, a dialog holds page keys, and a region key needs focus inside", () => {
  expect(pick(press("j", "KeyJ"), ["card.next"], free)).toEqual({ id: "card.next", chord: "j" });
  expect(pick(press("3", "Digit3"), ["card.next", "card.section"], free)).toEqual({ id: "card.section", chord: "3" });
  expect(pick(press("j", "KeyJ"), ["card.next"], { ...free, typing: true })).toBeNull();
  expect(pick(press("j", "KeyJ"), ["card.next"], { ...free, dialog: true })).toBeNull();
  expect(pick(press("k", "KeyK", { metaKey: true }), ["people.find"], { ...free, typing: true, dialog: true })?.id).toBe("people.find");
  // The people search takes ⌘⇧K too, as it always did, so the shell's palette never opens over it.
  expect(pick(press("K", "KeyK", { metaKey: true, shiftKey: true }), ["people.find"], free)?.id).toBe("people.find");
  const save = press("Enter", "Enter", { metaKey: true, shiftKey: true });
  expect(pick(save, ["registerSheet.save"], { ...free, typing: true })).toBeNull();
  expect(pick(save, ["registerSheet.save"], { ...free, typing: true, dialog: true, inRegion: true })?.id).toBe("registerSheet.save");
});

test("no two keys of one screen share a chord", () => {
  expect(conflicts(KEYMAP)).toEqual([]);
  expect(conflicts({ ...KEYMAP, "card.print": { keys: ["h"] } })).toEqual(["card.history and card.print both use h"]);
});

// Screens bind keys through the keymap. Listed here are the files that still listen on the document or window
// themselves; a new one fails, and a file that moves to the keymap leaves the list, so it only shrinks.
const OWN_LISTENERS = [
  "features/people/ui/grid-columns.tsx",
  "features/people/ui/masked-value.tsx",
  "features/structure/ui/use-drag-move.ts",
  // Not a shortcut: any key cancels a focus move that is still waiting.
  "lib/react/announce.ts",
  "lib/react/use-keys.ts",
  "shell/shell.tsx",
  "ui/action-grid/action-grid.tsx",
  "ui/composer/composer.tsx",
  "ui/flexible-columns/flexible-columns.tsx",
  "ui/long-table/row-keys.ts",
];

test("only the listed files listen for keys on the document or window", () => {
  const src = fileURLToPath(new URL("../..", import.meta.url));
  const found = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter(f => /\.tsx?$/.test(f) && !/\.(test|gallery|browser-fixture)\./.test(f))
    .filter(f => /(document|window)\.addEventListener\(\s*["']keydown["']/.test(readFileSync(src + f, "utf8")))
    .sort();
  expect(found).toEqual(OWN_LISTENERS);
});
