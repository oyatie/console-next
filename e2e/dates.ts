// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { koDate } from "./flows";

/** A business date with its weekday, as employee sentences and the next-record box show it. */
export const koDay = (ymd: string) =>
  `${koDate(ymd)} (${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date(`${ymd}T00:00:00+09:00`))})`;

export async function openAsOf(page: Page) {
  await page.getByRole("region", { name: "기준일", exact: true }).getByRole("button", { name: /^기준일 · / }).click();
  return page.getByRole("dialog", { name: "기준일", exact: true });
}
