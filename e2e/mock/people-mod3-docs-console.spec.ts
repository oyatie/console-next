// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { failure } from "./fixtures";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { SAEON_CERT_ID, SAEON_EXIT_CASE_ID, SAEON_NOTICE_ID, saeonUniverse } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));

const capture = async (page: Page, width: 1440 | 390, name: string, theme: "light" | "dark") => {
  const dir = process.env.STRUCT_SHOTS;
  if (!dir) return;
  if ((await page.locator('[role="dialog"]').count()) > 0) {
    await page.screenshot({ path: `${dir}/${name}--${width}-${theme}.png`, fullPage: false });
    return;
  }
  await withFullPage(page, () => shot(page, `${name}--${width}-${theme}`));
};

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console notices, exits, certificates & bulk exit (${width}px ${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupConsoleSaeonPeople(page, { theme, experience: "console", canManage: true });

      const bulkExitCalls: string[] = [];
      const singleExitCalls: string[] = [];
      page.on("request", req => {
        const u = new URL(req.url());
        if (req.method() === "POST" && u.pathname === "/api/v1/hr/exit-cases/bulk") bulkExitCalls.push(u.pathname);
        if (req.method() === "POST" && u.pathname === "/api/v1/hr/exit-cases") singleExitCalls.push(u.pathname);
      });

      try {
        const main = page.getByRole("main");

        // 1. /people/notices (P2 ListRecord)
        await page.goto("/people/notices");
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        await expect(main.getByText("2026-0041")).toBeVisible();
        await fits(page, `Console /people/notices ${width} ${theme}`);
        await expectAxe(page, `Console /people/notices ${width} ${theme}`);
        await capture(page, width, "people-notices", theme);

        // 2. /people/notices/new (P8 WizardPattern)
        await page.goto("/people/notices/new");
        await expect(page.locator('[data-pattern="wizard"]')).toHaveCount(1);
        await expect(main.getByRole("heading", { level: 1, name: t("notice.title") })).toBeVisible();
        await fits(page, `Console /people/notices/new ${width} ${theme}`);
        await expectAxe(page, `Console /people/notices/new ${width} ${theme}`);
        await capture(page, width, "people-notices-new", theme);

        // 3. /people/notices/$noticeId (P3 RecordPattern)
        await page.goto(`/people/notices/${SAEON_NOTICE_ID}`);
        await expect(page.locator('[data-pattern="record"]')).toHaveCount(1);
        await expect(main.getByText("2026-0041").first()).toBeVisible();
        await fits(page, `Console /people/notices/$noticeId ${width} ${theme}`);
        await expectAxe(page, `Console /people/notices/$noticeId ${width} ${theme}`);
        await capture(page, width, "people-notice-detail", theme);

        // 4. /people/exits (P2 ListRecord + WorklistSearchField)
        await page.goto("/people/exits");
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        if (width === 1440) {
          await expect(main.getByRole("button", { name: new RegExp(t("enum.exitCaseStatus.APPROVAL_DRAFTED")) })).toBeVisible();
        } else {
          const filterSelect = main.getByRole("combobox", { name: t("exit.list.chips") });
          await expect(filterSelect).toBeVisible();
          await expect(filterSelect.locator('option[value="APPROVAL_DRAFTED"]')).toHaveCount(1);
        }
        await expect(main.getByText(t("exit.next.mine"), { exact: true })).toHaveCount(0);
        const searchBox = main.getByRole("searchbox");
        await expect(searchBox).toBeVisible();
        await fits(page, `Console /people/exits ${width} ${theme}`);
        await expectAxe(page, `Console /people/exits ${width} ${theme}`);
        await capture(page, width, "people-exits", theme);

        // 5. /people/exits/$id (P4 DocumentDecision)
        await page.goto(`/people/exits/${SAEON_EXIT_CASE_ID}`);
        await expect(page.locator('[data-pattern="document-decision"]')).toHaveCount(1);
        await expect(main.getByText(t("reason.exit_reason.RESIGNATION"), { exact: true }).first()).toBeVisible();
        await expect(main.getByText(saeonUniverse.exitNotes.resignation, { exact: true }).first()).toBeVisible();
        await expect(main.getByText(t("exit.next.mine"), { exact: true })).toHaveCount(0);
        await expect(main.getByText(t("exit.next.current"), { exact: true })).toBeVisible();
        await fits(page, `Console /people/exits/$id ${width} ${theme}`);
        await expectAxe(page, `Console /people/exits/$id ${width} ${theme}`);
        await capture(page, width, "people-exit-detail", theme);

        // 6. /people/certificates (P2 ListRecord)
        await page.goto("/people/certificates");
        await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(1);
        await expect(page.locator("#certificate-settings")).toBeVisible();
        await expect(main.getByRole("button", { name: t("empDoc.certificate.issueAction"), exact: true })).toBeVisible();
        await expect(main.getByRole("searchbox")).toBeVisible();
        await fits(page, `Console /people/certificates ${width} ${theme}`);
        await expectAxe(page, `Console /people/certificates ${width} ${theme}`);
        await capture(page, width, "people-certificates", theme);

        // 7. /people/certificates/$certificateId (P3 RecordPattern)
        await page.goto(`/people/certificates/${SAEON_CERT_ID}`);
        await expect(page.locator('[data-pattern="record"]')).toHaveCount(1);
        await expect(main.locator("[data-print-doc]")).toBeVisible();
        await fits(page, `Console /people/certificates/$certificateId ${width} ${theme}`);
        await expectAxe(page, `Console /people/certificates/$certificateId ${width} ${theme}`);
        await capture(page, width, "people-certificate-detail", theme);

        // 8. Bulk exit sheet from /people uses POST /api/v1/hr/exit-cases/bulk (single call)
        await page.goto("/people");
        const rows = main.locator('[role="row"][data-row-id]');
        await expect(rows.nth(1)).toBeVisible();
        await rows.nth(0).locator("label", { has: page.getByRole("checkbox") }).click();
        await rows.nth(1).locator("label", { has: page.getByRole("checkbox") }).click();
        await page.locator("#crud-roster-bulk-exit").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("textbox").first().fill("2026-11-30");
        await dialog.getByRole("textbox").last().fill("Batch resignation report");
        bulkExitCalls.length = 0;
        singleExitCalls.length = 0;
        await page.locator("#crud-bulk-exit").click();
        await expect.poll(() => bulkExitCalls.length).toBe(1);
        expect(singleExitCalls).toEqual([]);
        await fits(page, `Console bulk exit sheet ${width} ${theme}`);
        await expectAxe(page, `Console bulk exit sheet ${width} ${theme}`);
        await capture(page, width, "people-bulk-exit", theme);

        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console handles 403 refusal and preserves baseline on notices/exits/certificates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const refused = await setupConsoleSaeonPeople(page, { experience: "console", canManage: false });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/counts", { status: 403, json: failure("forbidden") });
  try {
    await page.goto("/people/exits");
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await page.goto(`/people/exits/${SAEON_EXIT_CASE_ID}`);
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await page.goto(`/people/certificates/${SAEON_CERT_ID}`);
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    expect(refused.unexpected).toEqual([]);
  } finally {
    refused.release();
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const baseline = await setupConsoleSaeonPeople(page, { experience: "baseline", canManage: true });
  try {
    for (const url of ["/people/notices", "/people/exits", `/people/exits/${SAEON_EXIT_CASE_ID}`, "/people/certificates", `/people/certificates/${SAEON_CERT_ID}`]) {
      await page.goto(url);
      await expect(page.locator("[data-pattern]")).toHaveCount(0);
    }
    expect(baseline.unexpected).toEqual([]);
  } finally {
    await page.close();
    baseline.release();
  }
});
