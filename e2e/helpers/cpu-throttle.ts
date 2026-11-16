// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";

/** Opt-in CI load reproduction; CDP is available only in Chromium. */
export async function throttleCPU(page: Page) {
  if (!process.env.E2E_CPU_THROTTLE || page.context().browser()?.browserType().name() !== "chromium") return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.E2E_CPU_THROTTLE) });
}
