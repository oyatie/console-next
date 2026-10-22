// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { expect, test, vi } from "vitest";
import { fillRegister } from "../e2e/helpers/register";

test("registration fills and commits visible dates without the retired manual-entry chip", async () => {
  const filled: string[] = [];
  const blurred: string[] = [];
  const field = (name: string): object => ({
    getByRole: (role: string, options: { name: string | RegExp }) => {
      if (role === "button" && options.name === "직접") throw new Error("DateField has no manual-entry chip");
      return field(String(options.name));
    },
    getByLabel: (label: string | RegExp) => field(String(label)),
    getByText: () => field(name),
    fill: async (value: string) => { if (name.includes("일")) filled.push(value); },
    blur: async () => { blurred.push(name); },
    click: vi.fn(),
  });
  await fillRegister(field("page") as Page, { name: "날짜 확인", hired: "2026-11-15", contractEnd: "2027-11-14" });
  expect(filled).toEqual(["2026-11-15", "2027-11-14"]);
  expect(blurred).toHaveLength(2);
});
