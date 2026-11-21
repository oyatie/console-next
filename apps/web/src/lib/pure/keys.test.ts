// SPDX-License-Identifier: LicenseRef-Proprietary
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { KEYMAP, conflicts, matches, modChord, pick, singleKey, type KeyEventLike, type KeyId } from "./keys";

const press = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const free = { typing: false, dialog: false, inRegion: false, singleKeys: true };
// The jamo a Korean input mode reports for the J position.
const jamo = press("ㅓ", "KeyJ");

test("letters match the physical key, so a Korean input mode still works", () => {
  expect(matches(jamo, "j")).toBe(true);
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

test("a single key is one printable character with no ⌘, Ctrl or Alt; Shift only picks the character", () => {
  for (const e of [press("j", "KeyJ"), press("J", "KeyJ", { shiftKey: true }), jamo, press("3", "Numpad3"), press("?", "Slash", { shiftKey: true })]) expect(singleKey(e), e.key).toBe(true);
  for (const e of [press("k", "KeyK", { metaKey: true }), press("k", "KeyK", { ctrlKey: true }), press("j", "KeyJ", { altKey: true }), press("Enter", "Enter"), press("Escape", "Escape"), press("F2", "F2"), press(" ", "Space")]) expect(singleKey(e), e.key).toBe(false);
});

test("with single keys off a page key of one character waits; chords and region keys still act", () => {
  const off = { ...free, singleKeys: false };
  expect(pick(press("j", "KeyJ"), ["card.next"], off)).toBeNull();
  expect(pick(jamo, ["card.next"], off)).toBeNull();
  expect(pick(press("3", "Digit3"), ["card.next", "card.section"], off)).toBeNull();
  expect(pick(press("3", "Numpad3"), ["unplaced.place"], off)).toBeNull();
  expect(pick(press("?", "Slash", { shiftKey: true }), ["people.keys"], off)).toBeNull();
  expect(pick(press("?", "Slash", { shiftKey: true }), ["structure.keys"], off)).toBeNull();
  // The chord holds the key, not what the press reports: a letter or digit matches by position even when `key` is a
  // dead key, an unidentified one or a character of two code units.
  expect(pick(press("Dead", "KeyJ"), ["card.next"], off)).toBeNull();
  expect(pick(press("𝒿", "KeyJ"), ["card.next"], off)).toBeNull();
  expect(pick(press("Unidentified", "KeyK"), ["card.prev"], off)).toBeNull();
  expect(pick(press("Dead", "Digit6"), ["card.section"], off)).toBeNull();
  expect(pick(press("Dead", "KeyJ"), ["card.next"], free)?.id).toBe("card.next");
  // The people key map keeps a way in that is not a single key.
  for (const mod of [{ metaKey: true }, { ctrlKey: true }]) expect(pick(press("/", "Slash", mod), ["people.keys"], off)).toEqual({ id: "people.keys", chord: "Mod+/" });
  expect(pick(press("k", "KeyK", { metaKey: true }), ["people.find"], off)?.id).toBe("people.find");
  expect(pick(press("z", "KeyZ", { ctrlKey: true }), ["quick.undo"], off)?.id).toBe("quick.undo");
  expect(pick(press("Enter", "Enter", { metaKey: true }), ["registerRun.next"], off)?.id).toBe("registerRun.next");
  // A region key acts only while focus is inside its own component, so the setting leaves it alone.
  const list = { "list.open": { keys: ["o"], scope: "region" } } as const;
  expect(pick(press("o", "KeyO"), ["list.open" as KeyId], { ...off, inRegion: true }, list)).toEqual({ id: "list.open", chord: "o" });
  expect(pick(press("o", "KeyO"), ["list.open" as KeyId], off, list)).toBeNull();
  // The same binding page-wide is one the setting stops.
  expect(pick(press("o", "KeyO"), ["list.open" as KeyId], off, { "list.open": { keys: ["o"], scope: "page" } })).toBeNull();
  // Shift with a letter is still one character; a named key is not one.
  expect(pick(press("O", "KeyO", { shiftKey: true }), ["list.open" as KeyId], off, { "list.open": { keys: ["Shift+o"], scope: "page" } })).toBeNull();
  expect(pick(press("F2", "F2"), ["list.open" as KeyId], off, { "list.open": { keys: ["F2"], scope: "page" } })?.chord).toBe("F2");
});

test("with single keys on every binding acts as before", () => {
  expect(pick(press("j", "KeyJ"), ["card.next"], free)).toEqual({ id: "card.next", chord: "j" });
  expect(pick(press("5", "Digit5"), ["unplaced.place"], free)).toEqual({ id: "unplaced.place", chord: "5" });
  expect(pick(press("?", "Slash", { shiftKey: true }), ["people.keys"], free)).toEqual({ id: "people.keys", chord: "?" });
  expect(pick(press("k", "KeyK", { metaKey: true }), ["people.find"], free)?.id).toBe("people.find");
});

test("no two keys of one screen share a chord", () => {
  expect(conflicts(KEYMAP)).toEqual([]);
  expect(conflicts({ ...KEYMAP, "card.print": { keys: ["h"] } })).toEqual(["card.history and card.print both use h"]);
});

// Screens bind keys through the keymap. Listed here are the files that still listen on the document or window
// themselves; a new one fails, and a file that moves to the keymap leaves the list, so it only shrinks.
const OWN_LISTENERS = [
  // Not a shortcut: Escape re-masks revealed PII (paired with features/people/ui/masked-value.tsx).
  "features/account/ui/use-self-reveal.ts",
  "features/people/ui/grid-columns.tsx",
  "features/people/ui/masked-value.tsx",
  "features/structure/ui/use-drag-move.ts",
  // Not a shortcut: any key cancels a focus move that is still waiting.
  "lib/react/announce.ts",
  "lib/react/use-keys.ts",
  "shell/baseline/shell.tsx",
  "shell/frame/shell-frame.tsx",
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

test("modChord formats Command on Apple platforms and Ctrl on Windows, Linux, and SSR", () => {
  expect(modChord("↵")).toBe("Ctrl+↵");
  expect(modChord("↵", undefined)).toBe("Ctrl+↵");

  expect(modChord("↵", { userAgentData: { platform: "macOS" }, platform: "Win32", userAgent: "" })).toBe("⌘↵");
  expect(modChord("S", { userAgentData: { platform: "iOS" }, platform: "", userAgent: "" })).toBe("⌘S");
  expect(modChord("↵", { userAgentData: { platform: "Windows" }, platform: "MacIntel", userAgent: "" })).toBe("Ctrl+↵");
  expect(modChord("↵", { userAgentData: { platform: "Linux" }, platform: "Linux x86_64", userAgent: "" })).toBe("Ctrl+↵");

  for (const platform of ["MacIntel", "iPhone", "iPad", "iPod"]) {
    expect(modChord("↵", { platform, userAgent: "" }), platform).toBe("⌘↵");
  }
  for (const platform of ["Win32", "Linux x86_64"]) {
    expect(modChord("↵", { platform, userAgent: "" }), platform).toBe("Ctrl+↵");
  }

  expect(modChord("↵", { platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe("⌘↵");
  expect(modChord("↵", { platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("Ctrl+↵");

  expect(modChord("↵", true)).toBe("⌘↵");
  expect(modChord("↵", false)).toBe("Ctrl+↵");
});
