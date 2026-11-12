// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure, inbox } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) test(`an opened item shows its 활동 내역 at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const mock = await mockScreen(page, screens[0], "populated");
  const data = inbox(3);
  const item = data.items[0]!;
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  const reads: string[] = [];
  await mockRoute(page, "get", "/api/v1/me/action-inbox/items/{id}/activity", request => {
    reads.push(decodeURIComponent(new URL(request.url()).pathname));
    return { status: 200, json: { items: [
      { verb: "approve", actor_name: "김결재", occurred_at: "2026-11-11T05:00:00Z" },
      { verb: "other", occurred_at: "2026-11-10T05:00:00Z" },
      { verb: "submit", actor_name: "이요청", occurred_at: "2026-11-09T05:00:00Z" },
    ] } };
  });
  await page.goto(`/inbox?sel=${encodeURIComponent(item.id)}`);
  const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
  const rows = pane.getByRole("region", { name: t("home.inbox.activity.title"), exact: true }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`${t("home.inbox.activity.verb.approve")} · 김결재`);
  await expect(rows.nth(1)).toContainText(`${t("home.inbox.activity.verb.other")} · ${t("home.inbox.activity.system")}`);
  await expect(rows.nth(2)).toContainText(`${t("home.inbox.activity.verb.submit")} · 이요청`);
  expect(reads).toEqual([`/api/v1/me/action-inbox/items/${item.id}/activity`]);
  await fits(page, `inbox activity ${width}`);
  await expectAxe(page, `inbox activity ${width}`);
  await page.screenshot({ path: info.outputPath(`inbox-activity-${width}.png`), fullPage: true });
  expect(mock.unexpected).toEqual([]);
});

test("an activity read that fails stays inside its section", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "populated");
  const data = inbox(3);
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  await mockRoute(page, "get", "/api/v1/me/action-inbox/items/{id}/activity", { status: 503, json: failure("service_unavailable") });
  await page.goto(`/inbox?sel=${encodeURIComponent(data.items[0]!.id)}`);
  const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
  await expect(pane.getByRole("link", { name: t("home.inbox.record.original"), exact: true })).toBeVisible();
  await expect(pane.getByRole("region", { name: t("home.inbox.activity.title"), exact: true }).getByRole("listitem")).toHaveCount(0);
  await expect(pane).toContainText(data.items[0]!.title);
  expect(mock.unexpected).toEqual([]);
});
