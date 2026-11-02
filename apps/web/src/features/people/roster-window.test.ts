// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { rosterWindowQuery } from "./api/roster";
const contractWindowSettings = (value: unknown) => ({ items: [{ key: "hr.contract_soon_days", value }] }) as Parameters<typeof rosterWindowQuery.select>[0];

test.each([1, 21, 365])("the roster reads the effective %s day window", days => {
  expect(rosterWindowQuery.select(contractWindowSettings(days))).toBe(days);
});

test.each([0, -1, 1.5, NaN, undefined, "21"])("an invalid window %s cannot become a filter", value => {
  const data = contractWindowSettings(21);
  const invalid = { ...data, items: [{ ...data.items[0]!, value }] };
  expect(() => rosterWindowQuery.select(invalid as typeof data)).toThrow("hr.contract_soon_days");
});
