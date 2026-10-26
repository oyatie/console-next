// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, kstDate, registerEmployee } from "../flows";
import { openTenant } from "../helpers/tenant";
import { setupCompany, SETUP_DEPARTMENT, startOperations } from "../setup-flows";

// Production routes after a solo first run; this proof also runs against the served build.
test("a solo recorder reads routine ops badges on the employee ledger and entity history", async ({ browser }) => {
  const admin = await openTenant(browser, "matcoll", "기록상사");
  await setupCompany(admin, "기록상사");
  const entityPath = new URL(admin.url()).pathname;
  await startOperations(admin);
  await registerEmployee(admin, { name: "김기록", unit: SETUP_DEPARTMENT });
  const personPath = new URL(admin.url()).pathname;

  for (const path of [`${personPath}?tab=ledger`, `${personPath}?tab=events`, `${entityPath}?tab=history`]) {
    await go(admin, path);
    const badge = admin.locator(".chip").filter({ hasText: /^운영 계정$/ }).first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/chip--neutral/);
    await expect(badge).not.toHaveClass(/chip--warn/);
    await expect(admin.getByText(/긴급 권한/)).toHaveCount(0);
    await expect(admin.getByText("아직 기록된 변경이 없습니다. 조직도에서 변경하거나 목록을 붙여 넣으면 여기에 쌓입니다.")).toHaveCount(0);
    if (path === `${entityPath}?tab=history`) {
      await admin.setViewportSize({ width: 390, height: 844 });
      const labels = admin.locator("dt");
      await expect(labels.first()).toBeVisible();
      await admin.evaluate(() => document.fonts.ready);
      for (const label of await labels.all()) {
        const lines = await label.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        expect(lines, await label.textContent() ?? "").toBeLessThanOrEqual(2);
      }
      await admin.setViewportSize({ width: 1440, height: 900 });
    }
  }

  // Capacity fixture at the real read boundary, preserving the server's event shape.
  // The browser unit suite walks all 2,000 rows and checks live-insert focus in both lane modes.
  const eventsPath = `/api/v1/employees/${personPath.split("/").pop()}/lifecycle-events`;
  let eventCount = 2000;
  await admin.route(`**${eventsPath}`, async route => {
    const response = await route.fetch();
    const data = await response.json();
    expect(data.items.length).toBeGreaterThan(0);
    await route.fulfill({ response, json: { ...data, items: Array.from({ length: eventCount }, (_, i) => ({
      ...data.items[0], id: crypto.randomUUID(), effective_date: kstDate(-i), created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    })) } });
  });
  // A reload deliberately performs the read again instead of using the route query's cached result.
  await admin.goto(`${personPath}?tab=events`);
  const history = admin.getByRole("region", { name: "인사 이력", exact: true });
  const rows = history.locator('li[id^="ev-"]');
  await expect(rows).toHaveCount(50);
  const first = await rows.first().getAttribute("id");
  await history.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).not.toHaveAttribute("id", first!);
  await expect(history.getByRole("navigation")).toContainText("2,000");

  eventCount = 0;
  await admin.goto(`${personPath}?tab=events`);
  await expect(history.getByText("아직 기록된 발령이 없습니다", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(0);
});
