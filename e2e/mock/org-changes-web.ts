// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { failure, user } from "./fixtures";
import { orgChanges } from "./org-changes";
import { CHANGE_VIEWS } from "../../apps/web/src/features/org/api";

export type CountState = "loading" | "failed" | "counts-failed" | "counts-loading" | "populated" | "legacy";
/** Pending operation: switch to mockRoute when the generated contract includes counts. */
export async function mockOrgChangeCounts(page: Page, state: CountState, rows = orgChanges(3)) {
  const requests: URL[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/v1/org-changes/counts", async route => {
    requests.push(new URL(route.request().url()));
    if (state === "loading" || state === "counts-loading") await held;
    if (state === "failed" || state === "counts-failed") return route.fulfill({ status: 503, json: failure("service_unavailable") });
    if (state === "legacy") return route.fulfill({ status: 400, json: failure("bad_request") });
    const query = new URL(route.request().url()).searchParams;
    const counts = Object.fromEntries(Object.entries(CHANGE_VIEWS).map(([view, filter]) => [view, rows.filter(row =>
      (!filter.status.length || (filter.status as readonly string[]).includes(row.status)) && (!filter.mine || row.draftedBy === user.id) &&
      (!query.has("effective_from") || row.effectiveDate >= query.get("effective_from")!) && (!query.has("effective_to") || row.effectiveDate <= query.get("effective_to")!)
    ).length]));
    await route.fulfill({ json: counts });
  });
  return { requests, release };
}
