// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { afterEach, expect, test, vi } from "vitest";
import { fillRegister } from "../e2e/helpers/register";

class SelectStub {}
afterEach(() => vi.unstubAllGlobals());

// A fake page that draws the employment type the way one style does: Classic as a radio group of chips, Console as a select.
const fill = async (style: "classic" | "console") => {
  vi.stubGlobal("HTMLSelectElement", SelectStub);
  const drawn = (role: string) => !(role === "radiogroup" && style === "console") && !(role === "combobox" && style === "classic");
  const filled: string[] = [];
  const blurred: string[] = [];
  const clicked: string[] = [];
  const selected: string[] = [];
  const field = (name: string, role = ""): object => {
    const self = {
      getByRole: (r: string, options: { name: string | RegExp }) => {
        if (r === "button" && options.name === "직접") throw new Error("DateField has no manual-entry chip");
        return field(String(options.name), r);
      },
      getByLabel: (label: string | RegExp) => field(String(label)),
      getByText: (text: string | RegExp) => field(String(text)),
      // As in Playwright, `a.or(b)` resolves to whichever of the two the page draws.
      or: (other: object) => (drawn(role) ? self : other),
      evaluate: async (fn: (el: unknown) => unknown) => fn(role === "combobox" ? new SelectStub() : {}),
      fill: async (value: string) => { if (name.includes("일")) filled.push(value); },
      blur: async () => { blurred.push(name); },
      click: async () => { clicked.push(name); },
      selectOption: async (value: string) => { selected.push(value); },
    };
    return self;
  };
  await fillRegister(field("page") as Page, { name: "날짜 확인", hired: "2026-11-15", contractEnd: "2027-11-14" });
  return { filled, blurred, clicked, selected };
};

test("registration fills and commits visible dates without the retired manual-entry chip", async () => {
  const { filled, blurred } = await fill("classic");
  expect(filled).toEqual(["2026-11-15", "2027-11-14"]);
  expect(blurred).toHaveLength(2);
});

test("registration picks the employment type as a chip in Classic and from the select in Console", async () => {
  const classic = await fill("classic");
  expect(classic.clicked).toContain("계약직");
  expect(classic.selected).toEqual([]);
  const console = await fill("console");
  expect(console.selected).toEqual(["계약직"]);
  expect(console.clicked).not.toContain("계약직");
});
