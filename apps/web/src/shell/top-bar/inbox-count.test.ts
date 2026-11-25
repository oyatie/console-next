// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { inbox } from "../../../../../e2e/mock/fixtures";
import { newest } from "./inbox-count";

const page = (turn: number) => ({ ...inbox(0), counts: { turn: { total: turn, total_is_exact: true } } });
const read = (turn: number, at: number, placeholder = false) =>
  ({ isSuccess: true, isPlaceholderData: placeholder, dataUpdatedAt: at, data: { pages: [page(turn)], pageParams: [undefined] } }) as never;

test("a count shows the newest answer it has seen: another key's older copy never replaces it", () => {
  const first = newest({ at: 0 }, read(5, 100));
  expect(first.page?.counts.turn?.total).toBe(5);
  const later = newest(first, read(125, 200));
  expect(later.page?.counts.turn?.total).toBe(125);
  // Arriving where an older copy is cached (and being re-read): the newer count stays.
  expect(newest(later, read(5, 100))).toBe(later);
  // The re-read lands newer than both.
  expect(newest(later, read(7, 300)).page?.counts.turn?.total).toBe(7);
});

test("placeholder data and a read without an answer never replace the count shown", () => {
  const shown = newest({ at: 0 }, read(125, 200));
  expect(newest(shown, read(5, 300, true))).toBe(shown);
  expect(newest(shown, { isSuccess: false, isPlaceholderData: false, dataUpdatedAt: 0 } as never)).toBe(shown);
});
