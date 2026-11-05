// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { checklist, inbox } from "./fixtures";
import { screens } from "../states/registry";
import { fits, expectAxe } from "../a11y";

for (const setup of [false, true]) for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
  test(`privacy intake shares the queue at ${width}px ${theme} setup=${setup}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const queue = inbox(1);
    if (setup) queue.setup = checklist;
    queue.items = [{ ...queue.items[0]!, id: "privacy_request:request", kind: "privacy_request", title: "계정 로그인 기록", ref: "RR-001", site: undefined, urg: "wait", dueTone: "neutral", due: "2026-11-22T23:59:59+09:00", days_remaining: 17, links: [{ kind: "privacy_request", id: "request" }] }];
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: queue });
    await page.goto("/inbox");
    const row = page.locator('[data-id="privacy_request:request"]');
    await expect(row).toContainText("권리 요구");
    await expect(row).toContainText("RR-001");
    await expect(row).toContainText("D-17");
    await expect(row).toContainText("개인정보 권리 행사");
    await fits(page, "privacy intake");
    await expectAxe(page, "privacy intake");
    await page.screenshot({ path: info.outputPath(`intake-${width}-${theme}.png`), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}
