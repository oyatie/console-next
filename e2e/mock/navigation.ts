// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { routeReady, routeTarget } from "../flows";
import { throttleCPU } from "../helpers/cpu-throttle";

/** Cold mocked navigation keeps the same readiness contract as in-app navigation. */
export async function mockNavigate(page: Page, path: string) {
  await throttleCPU(page);
  await page.goto(path);
  await routeReady(page, routeTarget(page, path));
}
