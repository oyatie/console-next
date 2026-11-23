// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { i18n, loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, openBrowserTestPage, type Browser, type Page } from "../../../lib/browser-test";
import { SINGLE_KEYS_KEY } from "../../../lib/prefs";
import { authz, failure } from "../../../../../../e2e/mock/fixtures";
import { mockLifecycleSheets, moveDetail } from "../../../../../../e2e/mock/lifecycle-sheets";
import { mockRoute } from "../../../../../../e2e/mock/route";
import { lifecycleSheetScreens } from "../../../../../../e2e/states/lifecycle-sheets";

const [fixture] = Object.values(import.meta.glob<string>("./card-sections.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
// What the server answers for this reader: read at each request, so a test sets it and opens the card.
const reader = { manage: true, restricted: false };
beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
  server = await createServer({ configFile: false, cacheDir: ".cache/card-sections-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/people/ui/card-sections.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), realpathSync("node_modules/pretendard")] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/card-sections-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="en"><title>Card sections</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  // The card's reads, as the mock suite answers them for this person; a read it does not answer is refused.
  await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ status: 501, json: failure("unmocked_request") }));
  await mockLifecycleSheets(page, lifecycleSheetScreens[0]);
  const grant = (feature: string) => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false });
  await mockRoute(page, "get", "/api/v1/me/authz", () => ({ status: 200, json: { ...authz, capabilities: [...authz.capabilities, grant("documents"), ...(reader.manage ? [grant("employee_directory_manage")] : [])] } }));
  await mockRoute(page, "get", "/api/v1/employees/{id}/records", () => ({ status: 200, json: { sections: reader.restricted ? [{ section: "DISABILITY" as const, enabled: true }] : [], items: [] } }));
}, 120_000);
afterAll(async () => { i18n.set("ko"); await browser?.close(); await server?.close(); });

const links = () => page.getByRole("navigation", { name: t("uiRecord.sections"), exact: true }).getByRole("link");
const tab = (id: "card" | "ledger") => page.getByRole("navigation", { name: t("empCard.tabs"), exact: true }).getByRole("link", { name: t(`empCard.tab.${id}`), exact: true });
// A jump lands two frames after its key; a key that must do nothing is given that long, and more, to do it.
const settle = () => page.evaluate(() => new Promise<void>(done => { let n = 6; const tick = () => (--n ? requestAnimationFrame(tick) : done()); tick(); }));
async function open(as: Partial<typeof reader> = {}) {
  Object.assign(reader, { manage: true, restricted: false }, as);
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}card-sections-test?person=${moveDetail.employee.id}`, page.getByRole("heading", { level: 1, name: moveDetail.employee.name }));
  await element(tab("card")).toHaveAttribute("aria-current", "page");
}
/** Every link's cap is the digit that opens its section and marks the link, and the number in the section's head. */
async function capsOpenTheirSections() {
  const all = await links().all();
  for (const link of all) {
    const cap = (await link.locator("kbd").textContent())!;
    const section = page.locator((await link.getAttribute("href"))!);
    await page.keyboard.press(cap);
    await element(section, `key ${cap} opens the section of the link that shows ${cap}`).toBeFocused();
    await element(link).toHaveAttribute("aria-current", "true");
    await element(section.locator("[aria-hidden]").first()).toHaveText(cap);
  }
  return all.length;
}
const unshown = async () => { const caps = await links().locator("kbd").allTextContents(); return ["1", "2", "3", "4", "5", "6", "7", "8"].filter(d => !caps.includes(d)); };

test.each([{ restricted: false, count: 7 }, { restricted: true, count: 8 }])("each section link's key cap names the key that opens its section (restricted section shown: $restricted)", async ({ restricted, count }) => {
  await open({ restricted });
  await element(links()).toHaveCount(count);
  await element(links().filter({ hasText: t("empCard.sec.restricted") })).toHaveCount(restricted ? 1 : 0);
  await element(links().filter({ hasText: t("empCard.sec.docs") })).toHaveCount(1);
  expect(await capsOpenTheirSections()).toBe(count);
}, 90_000);

test("a digit that no section link shows does nothing, on the record and from another tab", async () => {
  await open();
  const second = links().nth(1);
  const section = page.locator((await second.getAttribute("href"))!);
  await second.click();
  await element(section).toBeFocused();
  const dead = await unshown();
  expect(dead).toHaveLength(1);
  const digit = dead[0]!;
  await page.keyboard.press(digit);
  await settle();
  await element(second, `key ${digit} is on no link`).toHaveAttribute("aria-current", "true");
  await element(section).toBeFocused();
  // From another tab a section's digit still returns to the record and opens it; a digit with no section stays put.
  await page.keyboard.press("h");
  await element(tab("ledger")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press(digit);
  await settle();
  await element(tab("ledger"), `key ${digit} has no section to return to`).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("3");
  await element(tab("card")).toHaveAttribute("aria-current", "page");
  await element(page.locator("#s3")).toBeFocused();
  await element(links().nth(2)).toHaveAttribute("aria-current", "true");
}, 90_000);

test("a reader's digits open the one section their record shows and nothing else", async () => {
  await open({ manage: false });
  await element(links()).toHaveCount(0);
  await page.keyboard.press("h");
  await element(tab("ledger")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("5");
  await settle();
  await element(tab("ledger")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("2");
  await element(tab("card")).toHaveAttribute("aria-current", "page");
  await element(page.locator("#s2")).toBeFocused();
}, 90_000);

test("a digit or H pressed in the print view leaves the tab and the current section where they were", async () => {
  await open();
  const printing = page.getByRole("heading", { level: 1, name: t("empDoc.print.title"), exact: true });
  const print = async () => { await page.getByRole("button", { name: t("empCard.verb.print"), exact: true }).click(); await element(printing).toBeVisible(); };
  const close = () => page.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
  // Opened from another tab: a section's digit does not send the reader to the record behind the print view.
  await page.keyboard.press("h");
  await element(tab("ledger")).toHaveAttribute("aria-current", "page");
  await print();
  await page.keyboard.press("3");
  await settle();
  await close();
  await element(tab("ledger")).toHaveAttribute("aria-current", "page");
  // Opened from the record: a digit does not move the current mark, and H does not change the tab.
  await tab("card").click();
  const second = links().nth(1);
  await second.click();
  await element(second).toHaveAttribute("aria-current", "true");
  await print();
  await page.keyboard.press("5");
  await page.keyboard.press("h");
  await settle();
  await close();
  await element(tab("card")).toHaveAttribute("aria-current", "page");
  await element(second).toHaveAttribute("aria-current", "true");
}, 90_000);

test("the card's key caps hide while single keys are off, and follow a change made in another tab", async () => {
  await open();
  const caps = page.locator("kbd").filter({ hasText: /^[JKH?]$/ });
  await element(caps).toHaveCount(4);
  const set = (value: string | null) => page.evaluate(([key, next]) => {
    if (next === null) localStorage.removeItem(key!); else localStorage.setItem(key!, next);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: next, storageArea: localStorage }));
  }, [SINGLE_KEYS_KEY, value] as const);
  try {
    await set("off");
    await element(caps).toHaveCount(0);
    await element(page.getByText(t("empCard.walk"))).toHaveCount(0);
  } finally { await set(null); }
  await element(caps).toHaveCount(4);
}, 90_000);

test("the digits wait while single keys are off or a key is composing, and a click or Enter on a link still opens its section", async () => {
  await open();
  const [first, fourth] = [links().first(), links().nth(3)];
  await links().nth(4).press("Enter");
  await element(page.locator("#s5")).toBeFocused();
  const compose = (isComposing: boolean) => page.evaluate(composing => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "4", code: "Digit4", isComposing: composing, bubbles: true, cancelable: true })), isComposing);
  await first.click();
  await element(page.locator("#s1")).toBeFocused();
  try {
    await page.evaluate(key => localStorage.setItem(key, "off"), SINGLE_KEYS_KEY);
    await page.keyboard.press("4");
    await settle();
    await element(first).toHaveAttribute("aria-current", "true");
    await element(page.locator("#s1")).toBeFocused();
  } finally { await page.evaluate(key => localStorage.removeItem(key), SINGLE_KEYS_KEY); }
  await compose(true);
  await settle();
  await element(first).toHaveAttribute("aria-current", "true");
  await compose(false);
  await element(page.locator("#s4")).toBeFocused();
  await element(fourth).toHaveAttribute("aria-current", "true");
}, 90_000);
