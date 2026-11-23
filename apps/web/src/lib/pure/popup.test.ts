// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { popupOpen } from "./popup";

const el = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null });

test("an expanded trigger with a declared popup, or an expanded combobox, has a popup open", () => {
  for (const popup of ["true", "listbox", "menu", "dialog"]) expect(popupOpen(el({ "aria-expanded": "true", "aria-haspopup": popup }))).toBe(true);
  expect(popupOpen(el({ "aria-expanded": "true", role: "combobox" }))).toBe(true);
});

test("a disclosure button, an unfolded row, a closed popup and a non-element have none", () => {
  expect(popupOpen(el({ "aria-expanded": "true" }))).toBe(false);
  expect(popupOpen(el({ "aria-expanded": "true", role: "row" }))).toBe(false);
  expect(popupOpen(el({ "aria-expanded": "true", "aria-haspopup": "false" }))).toBe(false);
  expect(popupOpen(el({ "aria-expanded": "false", "aria-haspopup": "listbox" }))).toBe(false);
  expect(popupOpen(el({ "aria-haspopup": "menu" }))).toBe(false);
  expect(popupOpen({})).toBe(false);
});
