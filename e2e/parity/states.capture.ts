import { expect, test, type Page } from "@playwright/test";
import { openTenant } from "../helpers/tenant";
import { go } from "../flows";
import { setupCompany, startOperations } from "../setup-flows";
import { capture } from "./capture";

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

async function readStates(a: Page, v: string, route: string, api: RegExp, loading: string[], error: string[]) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let called!: () => void;
  const request = new Promise<void>((resolve) => { called = resolve; });
  await a.route(api, async (r) => { called(); await held; await r.fallback(); });
  try {
    await a.goto(route);
    await request;
    await capture(a, v, loading, v === "people" ? "Controlled read delay with zero real facets: first-use empty replaces loading, no data response forged." : "Controlled read delay; actual loading geometry, no data response forged.");
  } finally {
    const loaded = a.waitForResponse((r) => api.test(r.url()) && r.status() === 200);
    release();
    await loaded;
    await a.unroute(api);
  }
  await a.route(api, (r) => r.fulfill({ status: 500, body: "" }));
  const failed = a.waitForResponse((r) => api.test(r.url()) && r.status() === 500);
  await a.reload();
  await failed;
  if (v === "people") {
    await expect(a.getByRole("region", { name: "아직 직원이 없습니다" })).toBeVisible();
    await expect(a.getByRole("alert")).toHaveCount(0);
    await capture(a, v, error, "Controlled GET500 with zero real facets: roster shows first-use empty instead of an error/retry. This is a product finding.");
  } else {
    await expect(a.getByRole("alert").first()).toBeVisible({ timeout: 25_000 });
    await capture(a, v, error, "Controlled GET500; actual retry/error rendering, all unrelated reads use the real backend.");
  }
  await a.unroute(api);
}

test("parity: Home loading, roster read failure and schedule read failure", async ({ browser }) => {
  const a = await openTenant(browser, "parity-states", "패리티상태");
  await setupCompany(a, "패리티상태", "본사");
  await startOperations(a);
  await readStates(a, "home-first-run", "/", /\/api\/v1\/employees\?.*identity_review_required=true/, ["H11-loading", "S1-loading"], ["H6-source-error"]);
  await readStates(a, "people", "/people", /\/api\/v1\/employees(\?|$)/, ["E12-loading", "R-loading"], ["E12-error", "R-error"]);
  await readStates(a, "attendance", "/attendance", /\/api\/v1\/attendance\/schedule\/tree/, ["A12-loading"], ["A12-error"]);
});

test("parity: remaining read and bulk entry surfaces", async ({ browser }) => {
  const a = await openTenant(browser, "parity-surfaces", "패리티경로");
  await setupCompany(a, "패리티경로", "본사");
  await go(a, "/people/import");
  await expect(a.getByRole("button", { name: "파일 선택" })).toBeVisible();
  await capture(a, "people", ["E7-upload"], "Actual roster-import file entry, before any uploaded file.");
  await go(a, "/people/grid");
  await capture(a, "people", ["E6-grid", "E6-columns"], "Actual employee edit grid in an empty roster.");
  await go(a, "/people/run");
  await capture(a, "people", ["E3-run"], "Actual consecutive-registration surface.");
  await go(a, "/people/notices/new");
  await capture(a, "people", ["N1-compose", "E5-notice"], "Actual notice-composer entry, no event selected or notice issued.");
  await go(a, "/access/grants/bulk");
  await capture(a, "access", ["M5-bulk-pick", "C12-bulk"], "Actual bulk-grant entry; no invited colleague/account/grant was created.");
  await go(a, "/org?view=list");
  await capture(a, "org", ["S13-lists", "S13-lists--empty"], "Actual structure list route, no departments.");
});
