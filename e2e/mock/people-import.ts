// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import { AT, failure, id, token, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";
import type { PeopleImportState } from "../states/people-import";

const run: components["schemas"]["EmployeeImportRun"] = {
  id: id(4000), source_filename: "synthetic-roster.xlsx", status: "APPLIED", apply_job_state: "done",
  created_at: AT, applied_at: AT, applied_by: { id: user.id, name: user.display_name },
  apply_summary: { input_rows: 3, inserted: 3, updated: 0, skipped: 0, companies: [] },
  rolled_back_at: null, rolled_back_by: null, rollback_reason_code: null, rollback_note: null,
  rollback: { job: null, refusal_code: null, mode: "GOVERNED", window_until: null, window_days: 14, pending_request: null }, allowed: [],
};

export async function mockPeopleImport(page: Page, state: PeopleImportState) {
  // LAND-ORDER: reuse the shared shell until UI-DECOUPLE can spread this lane's screen records.
  const shell = await mockScreen(page, screens[0], "empty");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let recovering = false;
  let refreshes = 0;
  await page.route("**/api/v1/auth/token/refresh", async route => {
    refreshes++;
    await route.fulfill(recovering ? { status: 503, json: failure("service_unavailable") } : { status: 200, json: token() });
  });
  await mockRoute(page, "get", "/api/v1/legal-entities", async () => {
    if (state === "loading") await held;
    if (state === "token-refresh-failed") { recovering = true; return { status: 401, json: failure("unauthorized") }; }
    return state === "entities-failed" ? { status: 503, json: failure("service_unavailable") }
      : state === "refused" ? { status: 403, json: failure("forbidden") } : { status: 200, json: { items: [] } };
  });
  await mockRoute(page, "get", "/api/v1/employee-number-rules", state === "numbers-failed" ? { status: 503, json: failure("service_unavailable") } : { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/reason-codes", state === "reasons-failed" ? { status: 503, json: failure("service_unavailable") } : { status: 200, json: { domain: "import_exclude", items: [] } });
  await mockRoute(page, "get", "/api/v1/employee-import-runs", { status: 200, json: { items: state === "populated" ? [run] : [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/employee-import-runs/{run_id}", { status: 200, json: run });
  await mockRoute(page, "get", "/api/v1/employees/import/{run_id}/reconcile", { status: 503, json: failure("service_unavailable") });
  return { ...shell, refreshes: () => refreshes, release: () => { release(); shell.release(); } };
}
