// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { checklist, failure, inbox, user } from "./fixtures";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`inbox shares Home rows and server URL filters at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "populated");
    const queue = inbox(8);
    queue.available_filters = ["turn", "scheduled", "waiting", "deadlines", "failures"];
    queue.counts = { turn: { total: 31, total_is_exact: false } };
    await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
      const query = new URL(request.url()).searchParams;
      const offset = query.has("cursor") ? 8 : 0;
      const items = query.get("filter") === "scheduled" ? [] : queue.items;
      return { status: 200, json: { ...queue, items: offset ? [{ ...queue.items[0]!, id: "second-page", title: "다음 페이지 직원" }] : items, next_cursor: offset || !items.length ? null : "next" } };
    });
    await page.goto("/");
    const preview = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
    await expect(preview.locator("[data-id]")).toHaveCount(5);
    await expect(preview.getByRole("navigation")).toHaveCount(0);
    await expect(preview.getByRole("button", { name: t("home.inbox.more"), exact: true })).toHaveCount(0);
    await preview.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: t("home.lanes"), exact: true });
    await expect(tabs.getByRole("link")).toHaveCount(queue.available_filters.length);
    await expect(tabs.getByRole("link").first()).toContainText("31+");
    await expect(tabs.getByRole("link").nth(1)).not.toContainText("0");
    await expect(preview.locator("[data-id]")).toHaveCount(8);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await preview.getByRole("button", { name: t("home.inbox.more"), exact: true }).click();
    await expect(preview.locator('[data-id="second-page"]')).toContainText("다음 페이지 직원");
    await tabs.getByRole("link", { name: t("home.inbox.filter.scheduled"), exact: true }).click();
    await expect(page).toHaveURL(/\?tab=scheduled$/);
    await expect(tabs.getByRole("link", { name: t("home.inbox.filter.scheduled"), exact: true })).toHaveAttribute("aria-current", "page");
    await expect(preview.getByRole("heading", { name: t("home.inbox.empty.title"), exact: true })).toBeVisible();
    await page.reload();
    await expect(tabs.getByRole("link", { name: t("home.inbox.filter.scheduled"), exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`inbox-${width}-${theme}.png`), fullPage: true });
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    expect(mock.unexpected).toEqual([]);
  });
}

test("setup inbox sends the caller Home without duplicating checklist or account work", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(1), setup: { ...checklist, phase: "SETUP" } } });
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator("[data-id]")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: t("home.lanes"), exact: true })).toHaveCount(0);
  const home = page.locator("main").getByRole("link", { name: t("shell.link.home"), exact: true });
  await expect(home).toHaveAttribute("href", "/");
  expect(mock.unexpected).toEqual([]);
});

test("inbox keeps its title on failed reads and retries without claiming empty", async ({ page }) => {
  await mockScreen(page, screens[0], "failed");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(t("home.inbox.empty.title"), { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true }).locator('[data-bone="short"]')).toHaveCount(0);
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(1) });
  await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
  await expect(page.locator("[data-id]")).toHaveCount(1);
});

test("Home hides the inbox link when the server offers no work or personal filter", async ({ page }) => {
  await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), available_filters: [] } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true })).toHaveCount(0);
});

for (const path of ["/", "/inbox"]) {
  test(`an empty queue on ${path} shows arriving items without a refresh`, async ({ page }) => {
    const mock = await mockScreen(page, screens[0], "empty");
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const emit = () => controller.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"inbox","id":null}\n\n'));
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          window.addEventListener("inbox-arrival", emit);
          request.signal.addEventListener("abort", () => { window.removeEventListener("inbox-arrival", emit); controller.close(); }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    });
    let queue = inbox(0);
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: queue }));
    await page.goto(path);
    await expect(page.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
    let loads = 0;
    page.on("load", () => { loads++; });
    queue = inbox(1);
    await page.evaluate(() => window.dispatchEvent(new Event("inbox-arrival")));
    await expect(page.locator("main [data-id]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^새 항목 \d+건 · 새로 고침$/ })).toHaveCount(0);
    expect(loads).toBe(0);
    expect(mock.unexpected).toEqual([]);
  });
}

test("a refused queue uses the shared refusal and never paints cached work", async ({ page }) => {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 403, json: failure("forbidden") });
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(page.locator("[data-id]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
});

test("entering the inbox refreshes a cached setup phase after operations start", async ({ page }) => {
  await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { name: user.tenant!.name, phase: "SETUP", go_live_at: null } } });
  await page.goto("/");
  const open = page.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true });
  await expect(open).toBeVisible();
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: user });
  await open.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.locator("main [data-id]")).toHaveCount(3);
  await expect(page.getByText(t("home.inbox.setup.title"), { exact: true })).toHaveCount(0);
});

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) {
  test(`queue header holds its place on ${path} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockScreen(page, screens[0], "loading");
    await page.goto(path);
    const queue = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
    await expect(queue.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    const body = queue.locator(":scope > div").last();
    const before = (await body.boundingBox())!.y;
    mock.release();
    await expect(queue.locator("[data-id]")).toHaveCount(3);
    expect((await body.boundingBox())!.y).toBe(before);
    expect(mock.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) for (const state of ["loading", "empty", "setup", "no-grant-setup", "partial", "failed", "refused"] as const) {
  test(`inbox ${state} at ${width}px in both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const mock = await mockScreen(page, screens[0], ["loading", "empty", "failed", "refused"].includes(state) ? state as "loading" | "empty" | "failed" | "refused" : "populated");
    if (state === "setup") await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(1), setup: { ...checklist, phase: "SETUP" } } });
    if (state === "no-grant-setup") {
      await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { name: user.tenant!.name, phase: "SETUP", go_live_at: null } } });
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: inbox(0) });
    }
    if (state === "partial") await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(1), unavailable: [{ source: "hr_register", support_reference: "inbox-source-reference" }] } });
    await page.goto("/inbox");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
    if (state === "loading") await expect(main.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    else if (state === "failed") await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    else if (state === "refused") await expect(main.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    else if (state === "setup" || state === "no-grant-setup") await expect(main.getByRole("link", { name: t("shell.link.home"), exact: true })).toBeVisible();
    else if (state === "partial") {
      await expect(main.locator("[data-id]")).toHaveCount(1);
      await expect(main.getByRole("alert")).toContainText("inbox-source-reference");
    } else await expect(main.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
    await fits(page, `inbox ${state}`);
    await expectAxe(page, `inbox ${state} at ${width}px`);
    mock.release();
    expect(mock.unexpected).toEqual([]);
  });
}
