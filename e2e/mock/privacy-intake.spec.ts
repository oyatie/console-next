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
    queue.items = [{ ...queue.items[0]!, id: "privacy_request:request", kind: "privacy_request", title: "RR-001", who: "김요구", context: { privacy_kinds: ["ACCESS", "DELETION"] }, ref: "RR-001", site: undefined, urg: "wait", dueTone: "neutral", due: "2026-11-22T23:59:59+09:00", days_remaining: 17, links: [{ kind: "privacy_request", id: "request" }] }];
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: queue });
    const receipt = { id: "request", receipt_no: "RR-001", detail: "상세내용".repeat(500), status: "RECEIVED", receipt: { controller: "TENANT", received_on: "2026-11-05", identity_at: "2026-11-05T01:00:00Z" }, kinds: { ACCESS: { due: { on: "2026-11-22", without_delay: false, rule: null }, decisions: [] }, DELETION: { due: null, decisions: [] } } };
    await page.route("**/api/v1/privacy/rights-requests/request", route => route.fulfill({ json: { request: receipt, subject_name: "김요구", as_of: "2026-11-05" } }));
    await page.goto("/inbox");
    const row = page.locator('[data-id="privacy_request:request"]');
    await expect(row).toContainText("권리 요구");
    await expect(row).toContainText("RR-001");
    await expect(row).toContainText("D-17");
    await expect(row).toContainText("김요구");
    await expect(row).toContainText("열람 · 삭제");
    await expect(row.getByRole("link")).toHaveCount(1);
    await expect(row.getByRole("link")).toHaveAttribute("href", "/account/privacy/intake/request");
    expect((await row.boundingBox())!.height).toBeLessThan(400);
    await expect(row).toContainText("개인정보 권리 행사");
    await fits(page, "privacy intake");
    await expectAxe(page, "privacy intake");
    await page.screenshot({ path: info.outputPath(`intake-${width}-${theme}.png`), fullPage: true });
    await row.getByRole("link").click();
    await expect(page.getByRole("heading", { name: "권리 요구 접수 내역", exact: true })).toBeVisible();
    await expect(page.getByText("김요구", { exact: true }).last()).toBeVisible();
    await expect(page.getByText(receipt.detail, { exact: true })).toBeVisible();
    await expect(page.getByText("열람 · 삭제", { exact: true })).toBeVisible();
    await expect(page.getByText("D-17", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /수용|거절|요구 접수/ })).toHaveCount(0);
    await fits(page, "privacy intake receipt");
    await expectAxe(page, "privacy intake receipt");
    await page.screenshot({ path: info.outputPath(`receipt-${width}-${theme}.png`), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}
