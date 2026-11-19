// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";

/** Drain query notifications while allowing throttled I/O to answer before the phase deadline. */
export async function advanceUntil(page: Page, request: Promise<unknown>) {
  let answered = false;
  void request.then(() => { answered = true; }, () => undefined);
  const start = await page.evaluate(() => Date.now());
  while (!answered) {
    await page.clock.runFor(50);
    // Page task yields can exhaust fake time before throttled I/O and rendering catch up.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await page.evaluate(() => Date.now()) - start).toBeLessThan(1_500);
  }
}
