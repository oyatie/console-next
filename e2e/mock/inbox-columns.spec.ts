// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { failure, inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { orgChange } from "./org-changes";

test.beforeAll(() => loadCatalog("ko"));
const rows = () => {
  const data = inbox(8);
  data.items = data.items.map((item, i) => {
    const days_remaining = i < 2 ? i - 2 : i;
    const due = new Date(Date.parse(data.as_of) + days_remaining * 86_400_000).toISOString();
    return { ...item, due, days_remaining, dueTone: i < 2 ? "danger" as const : i <= 3 ? "warn" as const : "neutral" as const, who: "김담당" };
  });
  return data;
};

for (const path of ["/", "/inbox"]) {
  test(`columns follow keyboard selection and survive reload on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const mock = await mockScreen(page, screens[0], "populated");
    const data = rows();
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
    await page.goto(`${path}?${path === "/inbox" ? "tab=turn&" : ""}sel=${encodeURIComponent(data.items[0]!.id)}`);
    const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
    await expect(pane).toContainText(data.items[0]!.title);
    const history = await page.evaluate(() => window.history.length);
    const listRows = page.locator("[data-flexible-columns] [data-id]");
    await listRows.first().focus();
    for (const key of ["j", "ArrowDown", "k", "ArrowUp"]) {
      await page.keyboard.press(key);
      const index = key === "j" || key === "k" ? 1 : key === "ArrowDown" ? 2 : 0;
      await expect(page).toHaveURL(new RegExp(`sel=${encodeURIComponent(data.items[index]!.id).replace(/%3A/g, "(?:%3A|:)")}`));
      await expect(pane).toContainText(data.items[index]!.title);
    }
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    if (path === "/inbox") expect(new URL(page.url()).searchParams.get("tab")).toBe("turn");
    await page.keyboard.press("/");
    await expect(listRows.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => pane.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(listRows.first()).toBeFocused();
    await expect(page).not.toHaveURL(/sel=/);
    await listRows.first().press("Enter");
    await page.reload();
    await expect(pane).toContainText(data.items[0]!.title);
    const splitter = page.getByRole("separator", { name: t("common.resizeColumn"), exact: true });
    const before = (await pane.boundingBox())!.width;
    const box = (await splitter.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x - 40, box.y + 20);
    await page.mouse.up();
    await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(before);
    expect(mock.unexpected).toEqual([]);
  });

  for (const width of [1440, 390]) for (const state of ["populated", "selected", "missing", "missing-empty", "empty", "failed", "refused", "loading"] as const) {
    test(`columns ${state} on ${path} at ${width}px in both themes`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const mock = await mockScreen(page, screens[0], state === "missing-empty" ? "empty" : state === "selected" || state === "missing" ? "populated" : state);
      const data = rows();
      if (["populated", "selected", "missing"].includes(state)) await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
      if (state === "failed") await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 500, json: failure("service_unavailable") });
      const selection = (state === "missing" || state === "missing-empty") ? "missing-item" : (state === "populated" || state === "empty") ? undefined : data.items[0]!.id;
      await page.goto(selection ? `${path}?sel=${encodeURIComponent(selection)}` : path);
      const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
      if (state === "selected") {
        await expect(page.locator("main [data-id]").first()).toBeAttached();
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
          await page.screenshot({ path: info.outputPath(`arrival-${path === "/" ? "home" : "inbox"}-${width}-${theme}.png`), fullPage: true });
        }
        await expect(pane).toContainText(data.items[0]!.title);
        await expect(pane).toContainText("김담당");
        await expect(pane.getByRole("link", { name: t("home.inbox.record.original"), exact: true })).toBeVisible();
        await expect(pane.getByRole("heading", { name: "활동 내역", exact: true })).toHaveCount(0);
        if (width === 390) {
          await expect(page.locator("[data-flexible-columns] > div").first()).toBeHidden();
          await expect(pane.getByRole("button", { name: t("common.back"), exact: true })).toBeVisible();
        }
      } else if (state === "missing" || state === "missing-empty") {
        await expect(pane.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toBeVisible();
      } else if (state === "populated") await expect(page.locator("main [data-id]")).toHaveCount(path === "/" ? 5 : 8);
      else if (state === "empty") await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
      else if (state === "failed") {
        await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.locator("main")).toContainText(failure("service_unavailable").error.operation_id!);
      } else if (state === "refused") await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      else await expect(page.locator('[data-read-layout="list"]')).toBeVisible();
      if (["empty", "failed", "refused", "loading"].includes(state)) await expect(pane).toHaveCount(0);
      await expectAxe(page, `columns ${path} ${state} ${width}`);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
        await fits(page, `columns ${path} ${state} ${width} ${theme}`);
        await page.screenshot({ path: info.outputPath(`${path === "/" ? "home" : "inbox"}-${state}-${width}-${theme}.png`), fullPage: true });
      }
      if (state === "missing" || state === "missing-empty") {
        await pane.getByRole("button", { name: t("home.inbox.record.back"), exact: true }).click();
        await expect(pane).toHaveCount(0);
      }
      if (state === "selected" && width === 390) {
        await pane.getByRole("button", { name: t("common.back"), exact: true }).click();
        await expect(page.locator("main [data-id]").first()).toBeFocused();
      }
      mock.release();
      expect(mock.unexpected).toEqual([]);
    });
  }
}

for (const path of ["/", "/inbox"]) test(`a decision in the record stays on ${path} and row commands do not select`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await mockScreen(page, screens[0], "populated");
  const detail = orgChange("approval");
  const data = inbox(2);
  data.items[1] = { ...data.items[1]!, kind: "org_change_approve", links: [{ kind: "org_change", id: detail.id }], context: { command: "approve" } };
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: detail });
  let decisions = 0;
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", request => {
    expect(request.postDataJSON()).toEqual({ decision: "APPROVED" });
    decisions++;
    return { status: 200, json: detail };
  });
  await page.goto(`${path}?${path === "/inbox" ? "tab=turn&" : ""}sel=${encodeURIComponent(data.items[0]!.id)}`);
  const row = page.locator("main [data-id]").nth(1);
  const approve = row.getByRole("button", { name: "조직 변경 승인", exact: true });
  await approve.click();
  await expect.poll(() => decisions).toBe(1);
  let observations = 0;
  await expect.poll(() => {
    expect(new URL(page.url()).searchParams.get("sel")).toBe(data.items[0]!.id);
    return ++observations;
  }, { intervals: [200], timeout: 1000 }).toBe(2);
  await row.focus();
  await row.press("Enter");
  const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
  await expect(pane).toContainText(data.items[1]!.title);
  await pane.getByRole("button", { name: "조직 변경 승인", exact: true }).click();
  await expect.poll(() => decisions).toBe(2);
  expect(new URL(page.url()).pathname).toBe(path);
  expect(mock.unexpected).toEqual([]);
});

for (const path of ["/", "/inbox"]) test(`folds expand in place and only their leaves select on ${path}`, async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "populated");
  const data = inbox(3);
  data.items = data.items.map((item, i) => ({ ...item, fold_key: i < 2 ? "contract-group" : undefined }));
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  await page.goto(path);
  await page.getByRole("button", { name: t("home.inbox.foldCount", { kind: t("people.lifecycle.action.CONTRACT_RENEWAL"), count: 2 }), exact: true }).click();
  await expect(page).not.toHaveURL(/sel=/);
  await page.locator(`[data-id="${data.items[0]!.id}"]`).click();
  await expect(page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true })).toContainText(data.items[0]!.title);
  await page.locator(`[data-id="fold:${data.items[0]!.id}"]`).focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).searchParams.get("sel")).toBe(data.items[0]!.id);
  expect(mock.unexpected).toEqual([]);
});
