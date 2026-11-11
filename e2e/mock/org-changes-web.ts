// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { failure } from "./fixtures";
import { orgChanges } from "./org-changes";

export type CountState = "loading" | "failed" | "counts-failed" | "counts-loading" | "populated";
/** Hold or refuse the contracted list reads used for saved-view totals. */
export async function mockOrgChangeCounts(page: Page, state: CountState, rows = orgChanges(3)) {
  const requests: URL[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/v1/org-changes" && url.searchParams.get("limit") === "1", async route => {
    const url = new URL(route.request().url());
    const query = url.searchParams;
    requests.push(url);
    if (state === "loading" || state === "counts-loading") await held;
    if (state === "failed" || state === "counts-failed") return route.fulfill({ status: 503, json: failure("service_unavailable") });
    const statuses = query.getAll("status").flatMap(value => value.split(","));
    const filtered = rows.filter(row =>
      (!statuses.length || statuses.includes(row.status)) && (!query.has("drafted_by") || row.draftedBy === query.get("drafted_by")) &&
      (!query.has("effective_from") || row.effectiveDate >= query.get("effective_from")!) && (!query.has("effective_to") || row.effectiveDate <= query.get("effective_to")!)
    );
    const json: components["schemas"]["OrgChangePage"] = { items: filtered.slice(0, 1), total: filtered.length };
    await route.fulfill({ json });
  });
  return { requests, release };
}
