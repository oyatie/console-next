// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { fixtureUrl } from "../../../../../../e2e/registration-void.fixture";

// Real React/React Aria controls in Chromium; only HTTP responses are substituted.
let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let origin: string;
let errors: string[];
let unexpected: string[];
let writes: Request[];
let reads: string[];
const previewPath = "/api/v1/business-registrations/reg-1/end-options";
const voidPath = "/api/v1/business-registrations/reg-1/void";
const options = (over = {}) => ({
  id: "reg-1", phase: "SETUP", delete: { allowed: true, refusal: null },
  can_manage: true, revisions: 7, linked_workplaces: [], ...over,
});
type Reply = { status?: number; json: unknown };
let preview: () => Promise<Reply>;
let submit: () => Promise<Reply | { status: 204 }>;

beforeAll(async () => {
  server = await createServer({
    root: resolve("apps/web"), configFile: resolve("apps/web/vite.config.ts"),
    cacheDir: resolve(".cache/vite-registration-void-test"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false },
    plugins: [{
      name: "registration-void-test",
      configureServer(vite) {
        vite.middlewares.use("/__registration-void", (_req, res, next) => {
          void vite.transformIndexHtml("/__registration-void", `<!doctype html><html lang="ko"><body><div id="root"></div><script type="module" src="/@fs${fileURLToPath(fixtureUrl)}"></script></body></html>`)
            .then((html) => { res.setHeader("Content-Type", "text/html"); res.end(html); }, next);
        });
      },
    }],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  errors = []; unexpected = []; writes = []; reads = [];
  preview = async () => ({ json: options() });
  submit = async () => ({ status: 204 });
  context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === previewPath) {
      reads.push(path);
      await route.fulfill(await preview());
    } else if (request.method() === "POST" && path === voidPath) {
      writes.push(request);
      await route.fulfill(await submit());
    } else {
      unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 404 });
    }
  });
});
afterEach(async () => {
  await context?.close();
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

const dialog = () => page.getByRole("dialog", { name: "사업자등록증 삭제", exact: true });
const confirm = () => dialog().getByRole("button", { name: "사업자등록증 삭제", exact: true });
async function open() {
  const more = page.getByRole("button", { name: "사업자등록증 더보기", exact: true });
  expect(await more.count()).toBe(1);
  await more.click();
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  await expect(dialog()).toBeVisible();
}
async function choose(label = "중복 등록") {
  await page.getByRole("radiogroup", { name: /삭제 사유/ }).getByText(label, { exact: true }).click();
  await expect(page.getByRole("radio", { name: label, exact: true })).toBeChecked();
}
async function mount(query = "") {
  await page.goto(`${origin}__registration-void${query ? `?${query}` : ""}`);
  await expect(page.getByRole("heading", { name: "사업자등록증", exact: true })).toBeVisible();
}

for (const [label, code] of [["중복 등록", "DUPLICATE"], ["시험 입력", "TEST_ENTRY"], ["다른 회사의 등록증", "WRONG_DOCUMENT"]]) {
  test(`mounted certificate menu → ${label} → registration void`, async () => {
    await mount();
    await open();
    await expect(dialog()).toContainText("000-81-00028");
    await expect(dialog()).toContainText("개정 이력 7건");
    await expect(confirm()).toBeDisabled();
    // The blocked control stays focusable but cannot send even a programmatic click.
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(writes).toEqual([]);
    await choose(label);
    await expect(confirm()).toBeEnabled();
    await confirm().click();
    await expect(dialog()).toHaveCount(0);
    expect(reads).toContain(previewPath);
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0]!.url()).pathname).toBe(voidPath);
    expect(writes[0]!.postDataJSON()).toEqual({ reason_code: code });
    expect(writes[0]!.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
}

test.each([
  ["linked workplace despite allowed flag", options({ linked_workplaces: [{ id: "wp-1", name: "서버에서 읽은 본점" }] }), "서버에서 읽은 본점"],
  ["record_in_use despite allowed flag", options({ delete: { allowed: true, refusal: "record_in_use" } }), "이 기록을 쓰는 곳이 있어 삭제할 수 없습니다"],
  ["phase_not_setup refusal", options({ delete: { allowed: false, refusal: "phase_not_setup" } }), "삭제 미리보기를 읽지 못했습니다"],
  ["denied without refusal", options({ delete: { allowed: false, refusal: null } }), "삭제 미리보기를 읽지 못했습니다"],
  ["revoked grant", options({ can_manage: false }), "이 계정에는 이 일을 할 권한이 없습니다"],
  ["operating", options({ phase: "OPERATING" }), "삭제할 수 없습니다"],
])("choosing a reason cannot bypass %s", async (_name, end, message) => {
  preview = async () => ({ json: end });
  await mount();
  await open();
  await expect(dialog()).toContainText("개정 이력 7건");
  await choose();
  await expect(dialog()).toContainText(message);
  await expect(confirm()).toBeDisabled();
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(writes).toEqual([]);
});

test("cached permission stays blocked during a paused offline refresh, then honors the fresh refusal", async () => {
  preview = async () => ({ json: options({ can_manage: false }) });
  await mount("cached");
  await context.setOffline(true);
  await open();
  await choose();
  await expect(confirm()).toBeDisabled();
  await expect(dialog()).not.toContainText("개정 이력 99건");
  expect(reads).toEqual([]);
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(writes).toEqual([]);
  await context.setOffline(false);
  await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(confirm()).toBeDisabled();
  expect(reads).toEqual([previewPath]);
  expect(writes).toEqual([]);
});

test("a cached preview stays blocked while loading or failed; retry reads current permission", async () => {
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((done) => { release = done; });
  preview = () => held;
  try {
    await mount("cached");
    await open();
    await choose();
    await expect(confirm()).toBeDisabled();
    await expect(dialog()).not.toContainText("개정 이력 99건");
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(writes).toEqual([]);
    release({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
    await expect(dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" })).toBeVisible();
    await expect(confirm()).toBeDisabled();
    preview = async () => ({ json: options() });
    await dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" }).click();
    await expect(dialog()).toContainText("개정 이력 7건");
    await expect(confirm()).toBeEnabled();
    expect(writes).toEqual([]);
  } finally {
    release({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
  }
});

test("pending submission blocks dismissal and repeat confirmation until success", async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  submit = async () => { await held; return { status: 204 }; };
  try {
    await mount();
    await open();
    await choose();
    await expect(confirm()).toBeEnabled();
    await confirm().click();
    await expect(confirm()).toBeDisabled();
    await dialog().getByRole("button", { name: "돌아가기", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await dialog().count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog()).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(dialog()).toBeVisible();
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(writes).toHaveLength(1);
    release();
    await expect(dialog()).toHaveCount(0);
    expect(writes).toHaveLength(1);
  } finally { release(); }
});

test("a command refusal keeps the dialog open and shows the server's reason", async () => {
  submit = async () => ({ status: 409, json: { error: { code: "record_in_use", message: "record_in_use" } } });
  await mount();
  await open();
  await choose();
  await expect(confirm()).toBeEnabled();
  await confirm().click();
  await expect(dialog().getByRole("alert")).toContainText("이 기록을 쓰는 곳이 있어 삭제할 수 없습니다");
  await expect(dialog()).toBeVisible();
  expect(writes).toHaveLength(1);
});

test("cancel closes without submitting and reopening requires a new preview and reason", async () => {
  await mount();
  await open();
  await choose();
  await expect(confirm()).toBeEnabled();
  await dialog().getByRole("button", { name: "돌아가기", exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  preview = async () => ({ json: options({ can_manage: false, revisions: 8 }) });
  await open();
  await expect(dialog()).toContainText("개정 이력 8건");
  await expect(page.getByRole("radio", { name: "중복 등록", exact: true })).not.toBeChecked();
  await choose();
  await expect(confirm()).toBeDisabled();
  expect(writes).toEqual([]);
});

test.each(["locked", "closed"])("a %s certificate has no deletion menu", async (state) => {
  await mount(state);
  await expect(page.getByRole("button", { name: "사업자등록증 더보기", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("the operating certificate menu explains why deletion is unavailable", async () => {
  await mount("operating");
  await page.getByRole("button", { name: "사업자등록증 더보기", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /삭제/ })).toBeDisabled();
  await expect(page.getByRole("menu")).toContainText("운영을 시작한 뒤에는 사업자등록증을 삭제할 수 없습니다");
  expect(writes).toEqual([]);
});

test("an allowed preview becomes blocked while an active refresh is fetching", async () => {
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((done) => { release = done; });
  try {
    await mount();
    await open();
    await choose();
    await expect(confirm()).toBeEnabled();
    preview = () => held;
    await page.evaluate(() => window.dispatchEvent(new Event("registration-preview-refresh")));
    await expect(confirm()).toBeDisabled();
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(writes).toEqual([]);
    release({ json: options({ can_manage: false }) });
    await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
    await expect(confirm()).toBeDisabled();
  } finally { release({ json: options() }); }
});

test("an offline active refresh blocks an earlier allowed preview until the fresh read lands", async () => {
  await mount();
  await open();
  await choose();
  await expect(confirm()).toBeEnabled();
  // Query tracks the offline event; navigator.onLine can change before its listener runs.
  await page.evaluate(() => {
    window.addEventListener("offline", () => {
      window.dispatchEvent(new Event("registration-preview-refresh"));
    }, { once: true });
  });
  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine);
  await expect(confirm()).toBeDisabled({ timeout: 1000 });
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(writes).toEqual([]);
  preview = async () => ({ json: options({ can_manage: false }) });
  await context.setOffline(false);
  await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(confirm()).toBeDisabled();
  expect(writes).toEqual([]);
});

test.each([1280, 390])("preview changes keep the dialog and controls in place at %ipx", async (width) => {
  await page.setViewportSize({ width, height: 844 });
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((done) => { release = done; });
  preview = () => held;
  try {
    await mount();
    await open();
    await choose();
    await page.evaluate(() => document.fonts.ready);
    const bounds = async () => Promise.all([dialog().boundingBox(), confirm().boundingBox(), page.getByRole("radio", { name: "중복 등록", exact: true }).boundingBox()]);
    const loading = await bounds();
    release({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
    const retry = dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" });
    await expect(retry).toBeVisible();
    expect(await bounds()).toEqual(loading);
    preview = async () => ({ json: options({ can_manage: false }) });
    await retry.click();
    await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
    expect(await bounds()).toEqual(loading);
    preview = async () => ({ json: options() });
    await page.evaluate(() => window.dispatchEvent(new Event("registration-preview-refresh")));
    await expect(confirm()).toBeEnabled();
    expect(await bounds()).toEqual(loading);
  } finally { release({ json: options() }); }
});
