// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { experienceState, seededExperience } from "../experience";
import { screens } from "../states/registry";
import { checklist, failure, inbox } from "./fixtures";
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
/** The queue's rows: Classic's column list, or Console's worklist grid (its deadline strip repeats the same ids). */
const queueRows = (page: Page) => page.locator("[data-flexible-columns] [data-id]")
  .or(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }).locator("[data-id]"));

for (const path of ["/", "/inbox"]) {
  test(`columns follow keyboard selection and survive reload on ${path}`, async ({ page, storageState }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const mock = await mockScreen(page, screens[0], "populated");
    const data = rows();
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
    await page.goto(`${path}?${path === "/inbox" ? "tab=turn&" : ""}sel=${encodeURIComponent(data.items[0]!.id)}`);
    const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
    await expect(pane).toContainText(data.items[0]!.title);
    const history = await page.evaluate(() => window.history.length);
    const listRows = queueRows(page);
    await listRows.first().focus();
    for (const key of ["j", "ArrowDown", "k", "ArrowUp"]) {
      await page.keyboard.press(key);
      const index = key === "j" || key === "k" ? 1 : key === "ArrowDown" ? 2 : 0;
      await expect(page).toHaveURL(new RegExp(`sel=${encodeURIComponent(data.items[index]!.id).replace(/%3A/g, "(?:%3A|:)")}`));
      await expect(pane).toContainText(data.items[index]!.title);
    }
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    // 해야 할 일 is the inbox's first tab, so its address carries no tab.
    if (path === "/inbox") expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
    await page.keyboard.press("/");
    if (seededExperience(storageState) === "baseline") {
      await expect(listRows.first()).toBeFocused();
    } else {
      await expect(page.getByRole("searchbox", { name: t("home.worklist.find"), exact: true })).toBeFocused();
      await listRows.first().focus();
    }
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
    test(`columns ${state} on ${path} at ${width}px in both themes`, async ({ page, storageState }, info) => {
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
        // 활동 내역 is the item's own read; the default mock answers no events.
        await expect(pane.getByRole("heading", { name: t("home.inbox.activity.title"), exact: true })).toHaveCount(1);
        await expect(pane).toContainText(t("home.inbox.activity.empty"));
        if (width === 390) {
          if (seededExperience(storageState) === "baseline") {
            await expect(page.locator("[data-flexible-columns] > div").first()).toBeHidden();
          }
          await expect(pane.getByRole("button", { name: t("common.back"), exact: true })).toBeVisible();
        }
      } else if (state === "missing" || state === "missing-empty") {
        await expect(pane.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toBeVisible();
      } else if (state === "populated") {
        // How many rows Home previews is each style's own (pinned below); the inbox lists them all.
        if (path === "/inbox") await expect(queueRows(page)).toHaveCount(8);
        else await expect(queueRows(page).first()).toBeVisible();
      }
      else if (state === "empty") await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
      else if (state === "failed") {
        await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.locator("main")).toContainText(failure("service_unavailable").error.operation_id!);
      } else if (state === "refused") await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      else await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
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

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) test(`a decision in the record stays on ${path} at ${width}px and row commands do not select`, async ({ page, storageState }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const approveName = seededExperience(storageState) === "baseline" ? "조직 변경 승인" : t("uiWorklist.approve");
  const mock = await mockScreen(page, screens[0], "populated");
  const detail = orgChange("approval");
  const data = inbox(2);
  data.items[1] = { ...data.items[1]!, kind: "org_change_approve", links: [{ kind: "org_change", id: detail.id }], context: { command: "approve" } };
  let decisions = 0;
  await mockRoute(page, "get", "/api/v1/me/action-inbox", () => {
    const items = decisions < 2 ? data.items : data.items.slice(0, 1);
    return { status: 200, json: { ...data, items, total: items.length, counts: { ...data.counts, turn: { total: items.length, total_is_exact: true } } } };
  });
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: detail });
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", request => {
    expect(request.postDataJSON()).toEqual({ decision: "APPROVED" });
    decisions++;
    return { status: 200, json: detail };
  });
  await page.goto(`${path}?${path === "/inbox" ? "tab=turn&" : ""}sel=${encodeURIComponent(data.items[0]!.id)}`);
  const row = page.locator("main [data-id]").nth(1);
  const approve = row.getByRole("button", { name: approveName, exact: true });
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
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(title => {
    const seen: string[] = [];
    const observer = new MutationObserver(changes => {
      for (const change of changes) for (const node of change.addedNodes) {
        if (node instanceof Element && [node, ...node.querySelectorAll("h2")].some(el => el.matches("h2") && el.textContent === title)) seen.push(title);
      }
    });
    observer.observe(document.querySelector("main")!, { childList: true, subtree: true });
    Object.assign(window, { missingRecordHeadings: seen });
  }, t("common.read.notFound.title"));
  await pane.getByRole("button", { name: approveName, exact: true }).click();
  await expect.poll(() => decisions).toBe(2);
  await expect(pane).toHaveCount(0);
  await expect(page).not.toHaveURL(/sel=/);
  await expect(page.locator("main [data-id]").first()).toBeFocused();
  await expect(page.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { missingRecordHeadings: string[] }).missingRecordHeadings)).toEqual([]);
  expect(new URL(page.url()).pathname).toBe(path);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await fits(page, `after decision ${path} ${width} ${theme}`);
    await page.screenshot({ path: info.outputPath(`decided-${path === "/" ? "home" : "inbox"}-${width}-${theme}.png`), fullPage: true });
  }
  await expectAxe(page, `after decision ${path} ${width}`);
  expect(mock.unexpected).toEqual([]);
});

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) {
  test(`Korean row keys respect composition, modifiers, controls and hidden rows on ${path} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockScreen(page, screens[0], "populated");
    const data = rows();
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
    await page.goto(path);
    const listRows = queueRows(page);
    const first = listRows.first();
    await expect(first).toBeVisible();
    await first.focus();
    for (const guard of [{ isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      await first.dispatchEvent("keydown", { key: "ㅓ", code: "KeyJ", ...guard });
      await expect(first).toBeFocused();
      await expect(page).not.toHaveURL(/sel=/);
    }
    const control = first.getByRole("link").first();
    await control.focus();
    await control.dispatchEvent("keydown", { key: "ㅓ", code: "KeyJ" });
    await expect(control).toBeFocused();
    await first.focus();
    await listRows.nth(1).evaluate(el => el.style.display = "none");
    await first.dispatchEvent("keydown", { key: "ㅓ", code: "KeyJ" });
    await expect(listRows.nth(2)).toBeFocused();
    await listRows.nth(2).dispatchEvent("keydown", { key: "ㅏ", code: "KeyK" });
    await expect(first).toBeFocused();
    await listRows.nth(1).evaluate(el => el.style.removeProperty("display"));
    await first.press("Enter");
    if (width === 390) {
      await page.getByRole("button", { name: t("common.back"), exact: true }).click();
      await expect(page).not.toHaveURL(/sel=/);
      await expect(page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true })).toHaveCount(0);
      await expect(first).toBeFocused();
    }
    await first.focus();
    await first.dispatchEvent("keydown", { key: "ㅓ", code: "KeyJ" });
    const pane = page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true });
    if (width === 1440) await expect(pane).toContainText(data.items[1]!.title);
    else await expect(listRows.nth(1)).toBeFocused();
    expect(mock.unexpected).toEqual([]);
  });
}

for (const path of ["/", "/inbox"]) test(`task links keep their own click without selecting on ${path}`, async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "populated");
  const data = rows();
  data.items[1] = { ...data.items[1]!, context: { command_id: "00000000-0000-4000-8000-000000000001" } };
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  await page.goto(`${path}?sel=${encodeURIComponent(data.items[0]!.id)}`);
  const link = page.locator("main [data-id]").nth(1).getByRole("link", { name: t("requestOutcome.open"), exact: true });
  await link.evaluate(el => el.addEventListener("click", event => event.preventDefault()));
  await link.click();
  let observations = 0;
  await expect.poll(() => {
    expect(new URL(page.url()).searchParams.get("sel")).toBe(data.items[0]!.id);
    return ++observations;
  }, { intervals: [200], timeout: 1000 }).toBe(2);
  expect(mock.unexpected).toEqual([]);
});

test("setup rows ignore a record selection at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const mock = await mockScreen(page, screens[0], "populated");
  const data = inbox(1);
  data.items[0] = { ...data.items[0]!, kind: "privacy_request" };
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...data, setup: checklist } });
  await page.goto(`/inbox?sel=${encodeURIComponent(data.items[0]!.id)}`);
  const row = page.locator("main [data-id]");
  await expect(row).toHaveCount(1);
  await expect(row).not.toHaveAttribute("data-selected");
  await expect(row).not.toHaveAttribute("aria-selected");
  await expect(page.locator("[data-flexible-columns]")).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});

/** A queue whose first two items fold under one row, opened and expanded on `path`; the first leaf is then selected. */
async function openFolds(page: Page, path: string) {
  const mock = await mockScreen(page, screens[0], "populated");
  const data = inbox(3);
  data.items = data.items.map((item, i) => ({ ...item, fold_key: i < 2 ? "contract-group" : undefined }));
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: data });
  await page.goto(path);
  await page.getByRole("button", { name: t("home.inbox.foldCount", { kind: t("people.lifecycle.action.CONTRACT_RENEWAL"), count: 2 }), exact: true }).click();
  await expect(page).not.toHaveURL(/sel=/);
  await page.locator(`[data-id="${data.items[0]!.id}"]`).click();
  await expect(page.getByRole("complementary", { name: t("home.inbox.record.title"), exact: true })).toContainText(data.items[0]!.title);
  return { mock, data };
}

for (const path of ["/", "/inbox"]) test(`folds expand in place and only their leaves select on ${path}`, async ({ page }) => {
  const { mock } = await openFolds(page, path);
  expect(mock.unexpected).toEqual([]);
});

// Classic keeps an expanded fold as its own row above its leaves; Console heads the fold with its first leaf's row. No
// board draws the queue's folds, so the Console value is the render's.
for (const path of ["/", "/inbox"]) test(`Classic's expanded fold row selects nothing on ${path}`, { tag: "@baseline" }, async ({ page }) => {
  const { data } = await openFolds(page, path);
  await page.locator(`[data-id="fold:${data.items[0]!.id}"]`).focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).searchParams.get("sel")).toBe(data.items[0]!.id);
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  for (const path of ["/", "/inbox"]) test(`Console heads an expanded fold with its first leaf on ${path}`, async ({ page }) => {
    const { data } = await openFolds(page, path);
    await expect(page.locator(`[data-id="fold:${data.items[0]!.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-id="${data.items[0]!.id}"]`).getByRole("button", { expanded: true })).toHaveCount(1);
  });
});

// Home previews the queue's first rows: five in Classic; ten in Console, as d-home draws them before its more button.
async function openHome(page: Page) {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(12) });
  await page.goto("/");
}

test("Classic Home previews five queue rows", { tag: "@baseline" }, async ({ page }) => {
  await openHome(page);
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(5);
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  test("Console Home lists ten queue rows", async ({ page }) => {
    await openHome(page);
    await expect(page.getByRole("grid", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(10);
  });
});
