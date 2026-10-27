// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { id, screenAccess, structure } from "./fixtures";
import { mockRoute } from "./route";
/** Work-page supporting reads; the shared screen factory owns the shell and primary read failures. */
export async function orgWorkReads(page: Page, state: string) {
  const tree = structure(state === "empty" ? 0 : 3);
  tree.phase = state === "operating" ? "OPERATING" : "SETUP";
  await mockRoute(page, "get", "/api/v1/access/me", request => ({ status: 200,
    json: screenAccess(new URL(request.headers().referer ?? request.url()).pathname, tree.phase),
  }));
  if (state !== "loading" && state !== "failed" && state !== "refused") {
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  }
  return { tree, workplaceId: id(4) };
}
