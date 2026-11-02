// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { chromium, type Browser, type Page } from "../../../lib/browser-test";
import { RunHeader } from "./run-page";
import type { PayrollRun } from "../api";
import { AT, id } from "../../../../../../e2e/mock/fixtures";
let browser: Browser;
let page: Page;
beforeAll(async () => { loadCatalog("ko"); browser = await chromium.launch(); page = await browser.newPage(); }, 60_000);
afterAll(async () => { await browser?.close(); });

test("the browser exposes six read-only stages, completed delivery and no current step for void runs", async () => {
  for (const status of ["STAGED", "ISSUED", "VOID"] as const) {
    const run: PayrollRun = { id: id(899), legal_entity_id: id(801), pay_group_id: id(812), source_label: "모의 급여", period_start: "2026-10-01", period_end: "2026-10-31", status, calculation_enabled: false, created_at: AT, updated_at: AT };
    await page.setContent(renderToStaticMarkup(<RunHeader run={run} />));
    const rail = page.getByRole("list", { name: t("payroll.stages.title") });
    expect(await rail.getByRole("listitem").count()).toBe(6);
    expect(await rail.locator('[aria-current="step"]').count()).toBe(status === "STAGED" ? 1 : 0);
    expect(await rail.locator('[data-state="done"]').count()).toBe(status === "ISSUED" ? 6 : 0);
    expect(await rail.getByRole("button").or(rail.getByRole("link")).count()).toBe(0);
  }
});
