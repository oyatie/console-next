// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";

/** Install before navigation so the query client uses the browser clock for every retry. */
export async function installFaultClock(page: Page) {
  await page.clock.install();
  return <T>(observe: () => T | Promise<T>) => expect.poll(async () => {
    // Two retries with exponential jitter: the longer delay is at most four seconds.
    await page.clock.fastForward(4_000);
    return observe();
  }, { intervals: [50] });
}
