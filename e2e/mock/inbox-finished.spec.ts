// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { inbox } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const DONE = [
  { id: "hr_request:r1", kind: "hr_request", title: "검증직원 하나", outcome: "APPLIED", completed_at: "2026-11-11T05:00:00Z", links: [{ kind: "change_request", id: "r1" }, { kind: "employee", id: "e1" }] },
  { id: "period_unlock:u1", kind: "period_unlock", title: "요청자", outcome: "APPROVED", completed_at: "2026-11-10T05:00:00Z", links: [{ kind: "period_lock", id: "l1" }] },
  { id: "identifier_correction:c1", kind: "identifier_correction", title: "검증법인", outcome: "DECLINED", completed_at: "2026-11-09T05:00:00Z", links: [{ kind: "identifier_correction", id: "c1" }] },
];

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`완료 lists my decisions with their outcome and record at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(3) });
    await mockRoute(page, "get", "/api/v1/me/action-inbox/done", { status: 200, json: { items: DONE, next_cursor: null } });
    await page.goto("/inbox?tab=done");
    const list = page.getByRole("region", { name: t("home.inbox.title"), exact: true }).getByRole("listitem");
    await expect(list).toHaveCount(3);
    await expect(page.getByRole("navigation", { name: t("home.lanes"), exact: true }).getByRole("link", { name: t("home.inbox.tab.done"), exact: true })).toHaveAttribute("aria-current", "page");
    for (const [row, outcome] of [[0, "APPLIED"], [1, "APPROVED"], [2, "DECLINED"]] as const) await expect(list.nth(row)).toContainText(t(`home.inbox.outcome.${outcome}`));
    await expect(list.nth(0).getByRole("link", { name: t("home.part.requests"), exact: true })).toHaveAttribute("href", "/people/requests?sel=r1&status=ALL");
    await expect(list.nth(1).getByRole("link", { name: t("home.part.unlocks"), exact: true })).toHaveAttribute("href", "/people/period-locks?review=l1");
    await expect(list.nth(2).getByRole("link", { name: t("entityRecord.corrections.title"), exact: true })).toHaveAttribute("href", "/org/entities?correction=c1#identifier-corrections");
    await fits(page, `inbox done ${width}px ${theme}`);
    await expectAxe(page, `inbox done ${width}px ${theme}`);
    await page.screenshot({ path: info.outputPath(`inbox-done-${width}-${theme}.png`), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}
