// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

export async function mockEntityCreate(page: Page) {
  // shortcut: reuse the org shell until UI-DECOUPLE adds entity screens to the shared Screen union.
  const shell = await mockScreen(page, screens[2], "empty");
  await mockRoute(page, "get", "/api/v1/registration-checks/availability", { status: 200, json: { available: false, reason: "NOT_CONFIGURED" } });
  await mockRoute(page, "get", "/api/v1/ref/lists/{key}/codes", request => ({ status: 200, json: {
    list: { key: new URL(request.url()).pathname.split("/").at(-2)!, status: "NOT_LOADED" as const }, items: [],
  } }));
  return shell;
}
