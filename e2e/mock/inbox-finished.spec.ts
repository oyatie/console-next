// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
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

const notice = (id: string, text: string, link: components["schemas"]["NotificationLink"], unread = false) => ({
  id, recipient_user_id: "00000000-0000-4000-8000-000000000001", category: "tenant.go_live", kind: "info", text, link, unread,
  created_at: "2026-11-11T05:00:00Z", read_at: null, resolved_at: null, muted: false,
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`참조 lists my notices and 확인 marks one read at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const writes: string[] = [];
    // The notices view answers the grant I have not confirmed; every other view is my ordinary queue.
    const grant = { ...inbox(1).items[0]!, id: "grant_notice:g1", kind: "grant_notice", title: "급여 담당", links: [{ kind: "access", id: "g1" }], context: { grants: [{
      grant_id: "g1", role_id: "role", role_name_ko: "급여 담당", domain: "hr_basic", level: "view",
      scope: { kind: "TENANT", node_id: null, include_descendants: true }, valid_from: "2026-01-01T00:00:00Z", valid_to: null, enforcement: "ENFORCED", caveats: [] as string[],
    } as const] } };
    let confirmed = false;
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => ({ status: 200, json: new URL(request.url()).searchParams.get("filter") === "notices"
      ? { ...inbox(0), items: confirmed ? [] : [grant] } : { ...inbox(3), counts: { ...inbox(3).counts, notices: { total: confirmed ? 0 : 1, total_is_exact: true } } } }));
    await mockRoute(page, "post", "/api/v1/access/grants/{grantId}/notice", request => {
      writes.push(new URL(request.url()).pathname);
      confirmed = true;
      return { status: 200, json: { grant_id: "g1", noticed_at: "2026-11-12T00:00:00Z", channel: "IN_APP" } };
    });
    let read = false;
    const unreadId = "10000000-0000-4000-8000-000000000001";
    await mockRoute(page, "get", "/api/v1/me/action-inbox/reference", () => ({ status: 200, json: { next_cursor: null, items: [
      notice(unreadId, "조직 변경 안내", { type: "object", kind: "org_change", id: "c1" }, !read),
      notice("10000000-0000-4000-8000-000000000002", "계정 연결 안내", { type: "object", kind: "employee", id: "e1" }),
      notice("10000000-0000-4000-8000-000000000003", "운영 복구 안내", { type: "screen", screen: "account" }),
      notice("10000000-0000-4000-8000-000000000004", "모르는 화면 안내", { type: "screen", screen: "somewhere/else" }),
    ] } }));
    await mockRoute(page, "post", "/api/v1/me/action-inbox/reference/{id}/read", request => {
      writes.push(new URL(request.url()).pathname);
      read = true;
      return { status: 200, json: notice(unreadId, "조직 변경 안내", { type: "object", kind: "org_change", id: "c1" }) };
    });
    await page.goto("/inbox?tab=reference");
    const list = page.getByRole("region", { name: t("home.inbox.title"), exact: true }).getByRole("listitem");
    await expect(list).toHaveCount(5);
    const tab = page.getByRole("link", { name: new RegExp(`^${t("home.inbox.tab.reference")}`) });
    await expect(tab).toHaveText(`${t("home.inbox.tab.reference")} 1`);
    await expect(list.nth(0).getByRole("button", { name: t("home.grantNotices.confirm", { role: "급여 담당" }), exact: true })).toBeVisible();
    await list.nth(0).getByRole("button", { name: t("home.grantNotices.confirm", { role: "급여 담당" }), exact: true }).click();
    await expect(list).toHaveCount(4);
    await expect(tab).toHaveText(`${t("home.inbox.tab.reference")} 0`);
    await expect(list.nth(0).getByRole("link", { name: "조직 변경 안내", exact: true })).toHaveAttribute("href", "/org/changes/c1");
    await expect(list.nth(1).getByRole("link", { name: "계정 연결 안내", exact: true })).toHaveAttribute("href", "/people/e1");
    await expect(list.nth(2).getByRole("link", { name: "운영 복구 안내", exact: true })).toHaveAttribute("href", "/account");
    await expect(list.nth(3).getByRole("link")).toHaveCount(0);
    await expect(list.nth(0)).toContainText(t("home.inbox.reference.unread"));
    await fits(page, `inbox reference ${width}px ${theme}`);
    await expectAxe(page, `inbox reference ${width}px ${theme}`);
    await page.screenshot({ path: info.outputPath(`inbox-reference-${width}-${theme}.png`), fullPage: true });
    await list.nth(0).getByRole("button", { name: t("home.inbox.reference.confirm"), exact: true }).click();
    await expect(list.nth(0)).not.toContainText(t("home.inbox.reference.unread"));
    await expect(list.getByRole("button")).toHaveCount(0);
    expect(writes).toEqual(["/api/v1/access/grants/g1/notice", `/api/v1/me/action-inbox/reference/${unreadId}/read`]);
    expect(mock.unexpected).toEqual([]);
  });
}
