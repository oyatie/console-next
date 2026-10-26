// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { AT, id, structure, user } from "./fixtures";
import { mockRoute } from "./route";
/** Work-page supporting reads; the shared screen factory owns the shell and primary read failures. */
export async function orgWorkReads(page: Page, state: string) {
  const tree = structure(state === "empty" ? 0 : 3);
  tree.phase = state === "operating" ? "OPERATING" : "SETUP";
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: tree.phase, as_of: AT, entries: [] } });
  if (state !== "loading" && state !== "failed" && state !== "refused") {
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  }
  return { tree, workplaceId: id(4) };
}
