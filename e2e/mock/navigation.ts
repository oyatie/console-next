// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { routeReady } from "../flows";
import { throttleCPU } from "../helpers/cpu-throttle";
import { redirectTargets } from "../helpers/route-list";

/** Cold mocked navigation keeps the same readiness contract as in-app navigation. */
export async function mockNavigate(page: Page, path: string) {
  await throttleCPU(page);
  await page.goto(path);
  await routeReady(page, redirectTargets[new URL(path, page.url()).pathname] ?? path);
}
