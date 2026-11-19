// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { commitLabel } from "../../../ui/composer/actions";

const [fixture] = Object.values(import.meta.glob<string>("./approval-decision.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/approval-decision-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/approvals/ui/approval-decision.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
}, 60_000);
afterEach(async () => { await page?.context().close(); });
afterAll(async () => { await browser?.close(); await server?.close(); });

// The document as the API serves it: the server names the decisions it offers and the reason catalog of each.
const served = {
  id: "approval-1", box: "pending", title: "Sales reorganisation", summary: "Sales 1 and Sales 2 become one team.", document_no: "AP-2026-001",
  source: { key: "org_change" }, status: { key: "IN_APPROVAL" }, requester: { id: "account-1", name: "Kim Drafter", role: "HR" },
  requested_at: "2026-11-03T01:00:00Z", facts: [], body: [{ key: "change", label: "Change", value: "Sales 1 and Sales 2 merge into Sales" }],
  route: [{ id: "draft", role_key: "hr", assignee: "Kim Drafter", state: "done" }, { id: "approve", role_key: "executive", assignee: "Park Approver", state: "current" }],
  viewer: { kind: "org_change", id: "change-1" }, revision: 1, fingerprint: "sha256:approval-1-r1", consequence: "final", opinion_max: 998,
  my_actions: { kind: "approve", return: { consequence: "back_to_drafter", reason_domain: "approval_return" }, reject: { consequence: "request_ends", reason_domain: "org_change_reject" } },
};
const RECORDED = {
  APPROVE: { answer: { decision: "APPROVED", status: "APPROVED" }, receipt: "approvals.receipt.approvedFinal" },
  REJECT: { answer: { decision: "REJECTED", status: "REJECTED" }, receipt: "approvals.receipt.rejected" },
  RETURN: { answer: { decision: "RETURNED", status: "DRAFT" }, receipt: "approvals.receipt.recorded" },
} as const;
type Decision = keyof typeof RECORDED;

/**
 * Opens the viewer on a mocked server, on a page of its own or (`column`) in the inbox's record column. Once a
 * decision is recorded the document is served without its decisions, as the real server does; with `stillOffered`
 * only after `withdraw` is called. With `hold` the decision is not answered until `release` is called.
 */
async function open({ stillOffered = false, hold = false, column = false } = {}) {
  let decided = false;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const withdraw = () => { stillOffered = false; };
  // A context of its own: axe opens a second page, which a browser-owned default context refuses.
  page = await (await browser.newContext()).newPage();
  await page.route("**/approval-decision-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Approval decision</title><main id="root"></main><script type="module" src="${fixture}"></script></html>` }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1", route => route.fulfill({ json: decided && !stillOffered ? { ...served, status: { key: "APPROVED" }, my_actions: { kind: "none" } } : served }));
  await page.route(url => url.pathname === "/api/v1/reason-codes", route => route.fulfill({ json: { items: ["POLICY_VIOLATION", "OTHER"].map(code => (
    { code, system: true, requires_note: code === "OTHER", involuntary: false, notice_required: false, active: true, label_ko: null, label_en: null })) } }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1/decision", async route => {
    if (hold) await held;
    decided = true;
    await route.fulfill({ json: RECORDED[(route.request().postDataJSON() as { decision: Decision }).decision].answer });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}approval-decision-test${column ? "?host=column" : ""}`);
  await approve().waitFor();
  return { release, withdraw };
}
const approve = () => page.getByRole("button", { name: commitLabel({ kind: "entityRecord", mode: "approve" }), exact: true });
const receiptOf = (decision: Decision) => page.getByRole("status").filter({ hasText: t(RECORDED[decision].receipt) });
/** What holds focus: the receipt by its words, anything else by its tag (BODY once focus has dropped to the page). */
const focused = () => page.evaluate(() => { const el = document.activeElement; return el?.getAttribute("role") === "status" ? el.textContent : el?.tagName; });

/** Makes the decision with the keyboard alone: Enter on a button, Space on the first reason. */
async function decideByKeyboard(decision: Decision) {
  if (decision === "APPROVE") await approve().focus();
  else {
    const name = t(decision === "REJECT" ? "uiApprovalCard.reject" : "uiApprovalCard.return");
    await page.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.press("Enter");
    await element(page.getByRole("heading", { name, exact: true })).toBeFocused();
    await page.getByRole("radio").first().focus();
    await page.keyboard.press("Space");
    // The opener is gone while its form is open: this is the form's commit.
    await page.getByRole("button", { name, exact: true }).focus();
  }
  await page.keyboard.press("Enter");
}

test.each(["APPROVE", "REJECT", "RETURN"] as const)("after %s by keyboard, focus is on the receipt, stays there once the document is read-only, and axe passes", async decision => {
  await open();
  await decideByKeyboard(decision);
  await element(receiptOf(decision)).toBeVisible();
  // The re-read document offers no decision, so the decision card has given way to a plain one.
  await element(page.getByRole("article")).toHaveCount(0);
  await element(page.getByRole("button")).toHaveCount(0);
  await expect.poll(focused).toBe(t(RECORDED[decision].receipt));
  // A keyboard decision leaves the focus outline on the receipt, so the person sees where focus went.
  expect(await receiptOf(decision).evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(" ")}`)).toEqual([]);
});

test("the decision card's own receipt takes focus, and keeps it when a later read turns the document read-only", async () => {
  const { withdraw } = await open({ stillOffered: true });
  await decideByKeyboard("APPROVE");
  // The re-read document still offers the decision, so the receipt is drawn by the decision card.
  await element(page.getByRole("article").getByRole("status")).toHaveText(t(RECORDED.APPROVE.receipt));
  await element(page.getByRole("button")).toHaveCount(0);
  await expect.poll(focused).toBe(t(RECORDED.APPROVE.receipt));
  // Coming back to the tab reads the document again; the plain card replaces the focused receipt with its own.
  withdraw();
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await element(page.getByRole("article")).toHaveCount(0);
  await element(receiptOf("APPROVE")).toBeVisible();
  await expect.poll(focused).toBe(t(RECORDED.APPROVE.receipt));
});

test("in the inbox's record column, a decision by keyboard moves focus to the receipt and the column stays open", async () => {
  await open({ column: true });
  await decideByKeyboard("REJECT");
  const receipt = page.getByRole("complementary", { name: t("approvals.document.title"), exact: true }).getByRole("status").filter({ hasText: t(RECORDED.REJECT.receipt) });
  await element(receipt).toBeVisible();
  await element(page.getByRole("article")).toHaveCount(0);
  await expect.poll(focused).toBe(t(RECORDED.REJECT.receipt));
});

test("after a decision by pointer, focus is on the receipt and no focus ring is drawn", async () => {
  await open();
  await approve().click();
  await element(receiptOf("APPROVE")).toBeVisible();
  await expect.poll(focused).toBe(t(RECORDED.APPROVE.receipt));
  expect(await receiptOf("APPROVE").evaluate(el => getComputedStyle(el).outlineStyle)).toBe("none");
});

test("a receipt that arrives while the person types in another control leaves focus there", async () => {
  const { release } = await open({ hold: true });
  await decideByKeyboard("APPROVE");
  await element(page.getByRole("article")).toHaveAttribute("aria-busy", "true");
  const find = page.getByRole("textbox", { name: t("approvals.filters.search"), exact: true });
  await find.click();
  await page.keyboard.type("sal");
  release();
  await element(receiptOf("APPROVE")).toBeVisible();
  await element(page.getByRole("button")).toHaveCount(0);
  await page.keyboard.type("es");
  await element(find).toHaveValue("sales");
  expect(await focused()).toBe("INPUT");
});
