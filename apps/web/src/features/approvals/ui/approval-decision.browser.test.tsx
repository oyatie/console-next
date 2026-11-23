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
const other = { ...served, id: "approval-2", title: "Purchase request", document_no: "AP-2026-002", fingerprint: "sha256:approval-2-r1" };
const RECORDED = {
  APPROVE: { answer: { decision: "APPROVED", status: "APPROVED" }, receipt: "approvals.receipt.approvedFinal" },
  REJECT: { answer: { decision: "REJECTED", status: "REJECTED" }, receipt: "approvals.receipt.rejected" },
  RETURN: { answer: { decision: "RETURNED", status: "DRAFT" }, receipt: "approvals.receipt.recorded" },
} as const;
type Decision = keyof typeof RECORDED;
/**
 * Where the decision is drawn: `page`, `all`, `pending` and `last` are the baseline hosts the fixture describes.
 * `console` is the Console inbox with the document chosen, `console-auto` the same inbox with the first document
 * opened by the inbox itself, and `console-page` the document's own Console page.
 */
type Host = "page" | "all" | "pending" | "last" | "console" | "console-auto" | "console-page";

/**
 * Opens a host on a mocked server. Once a decision is recorded the document is served without its decisions, as the
 * real server does; with `stillOffered` only after `withdraw` is called. `withdraw` before any decision is someone
 * else deciding, and `offer` hands the decision back. With `hold` the decision is not answered until `release` is
 * called. With `refuse` the first decision is refused because the document changed, and the document is then served
 * under a new fingerprint. `sent` counts the decisions sent. The pending box lists a document while it offers a
 * decision, and `others` adds a second document that does.
 */
async function open({ stillOffered = false, hold = false, refuse = false, host = "page" as Host, others = false } = {}) {
  let decided = false;
  let posts = 0;
  let revision = 1;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const withdraw = () => { decided = true; stillOffered = false; };
  const offer = () => { decided = false; };
  const document = () => decided && !stillOffered
    ? { ...served, status: { key: "APPROVED" }, my_actions: { kind: "none" } } : { ...served, revision, fingerprint: `sha256:approval-1-r${revision}` };
  // A context of its own: axe opens a second page, which a browser-owned default context refuses.
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.route("**/approval-decision-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Approval decision</title><main id="root"></main><script type="module" src="${fixture}"></script></html>` }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1", route => route.fulfill({ json: document() }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-2", route => route.fulfill({ json: other }));
  await page.route(url => url.pathname === "/api/v1/approvals", route => {
    const items = [...(document().my_actions.kind === "none" ? [] : [document()]), ...(others ? [other] : [])];
    return route.fulfill({ json: { items, focused: null, counts: { pending: items.length, upcoming: 0, requested: 0, reference: 0, completed: 0 }, sources: [], next_cursor: null } });
  });
  await page.route(url => url.pathname === "/api/v1/reason-codes", route => route.fulfill({ json: { items: ["POLICY_VIOLATION", "OTHER"].map(code => (
    { code, system: true, requires_note: code === "OTHER", involuntary: false, notice_required: false, active: true, label_ko: null, label_en: null })) } }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1/decision", async route => {
    posts += 1;
    if (hold) await held;
    if (refuse && posts === 1) {
      revision = 2;
      return route.fulfill({ status: 409, json: { error: { code: "approval_document_changed", message: "Document changed" } } });
    }
    decided = true;
    await route.fulfill({ json: RECORDED[(route.request().postDataJSON() as { decision: Decision }).decision].answer });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}approval-decision-test?host=${host}`);
  await approve().waitFor();
  return { release, withdraw, offer, sent: () => posts };
}
const approve = () => page.getByRole("button", { name: commitLabel({ kind: "entityRecord", mode: "approve" }), exact: true });
/** The find box beside the list: a text field in the baseline fixture, a search field in the Console inbox. */
const find = () => page.getByLabel(t("approvals.filters.search"), { exact: true });
/** The title of the recorded card: the Console hosts dock it under a pane heading of their own. */
const recordedTitle = (host: Host) => t(host.startsWith("console") ? "approvals.console.myDecision" : "approvals.viewer.decision");
/**
 * Sets the page's title to that line once it has been drawn, however briefly. It would be drawn where the card was,
 * so a locator that waits for the receipt cannot tell whether it was there first.
 */
const watchForWithdrawn = () => page.evaluate(line => {
  new MutationObserver(() => { if (document.body.textContent.includes(line)) document.title = line; }).observe(document.body, { childList: true, subtree: true, characterData: true });
}, t("approvals.viewer.unavailable"));
const receiptOf = (decision: Decision) => page.getByRole("status").filter({ hasText: t(RECORDED[decision].receipt) });
/** What holds focus: a heading or a status line by its words, anything else by its tag (BODY once focus has dropped to the page). */
const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  return el && (el.getAttribute("role") === "status" || /^H\d$/.test(el.tagName)) ? el.textContent : el?.tagName;
});

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

test.each(["APPROVE", "REJECT", "RETURN"] as const)("after %s by keyboard, focus is on the recorded heading, no line for a withdrawn decision is drawn on the way, and axe passes", async decision => {
  await open();
  await watchForWithdrawn();
  await decideByKeyboard(decision);
  await element(receiptOf(decision)).toBeVisible();
  await element(page.getByRole("button")).toHaveCount(0);
  await expect.poll(focused).toBe(recordedTitle("page"));
  expect(await page.title(), "a recorded decision never shows the line for a withdrawn one").toBe("Approval decision");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(" ")}`)).toEqual([]);
});

test("a receipt that arrives while the person types in another control leaves focus there", async () => {
  const { release } = await open({ hold: true });
  await decideByKeyboard("APPROVE");
  await element(page.getByRole("article")).toHaveAttribute("aria-busy", "true");
  await find().click();
  await page.keyboard.type("sal");
  release();
  await element(receiptOf("APPROVE")).toBeVisible();
  await page.keyboard.type("es");
  await element(find()).toHaveValue("sales");
  expect(await focused()).toBe("INPUT");
});

test.each([
  ["APPROVE", "after a wait", "page"], ["REJECT", "after a wait", "page"], ["APPROVE", "at once", "page"],
  ["APPROVE", "after a wait", "console"], ["REJECT", "after a wait", "console-page"],
] as const)("when the server refuses %s made by keyboard %s on %s, focus is back on the commit and a second Enter is sent", async (decision, answered, host) => {
  const { release, sent } = await open({ hold: answered === "after a wait", refuse: true, host });
  await decideByKeyboard(decision);
  // The pressed commit is disabled while the server holds the decision, and the browser drops focus to the page.
  // A refusal that comes at once can arrive before the browser has done so.
  if (answered === "after a wait") await expect.poll(focused).toBe("BODY");
  release();
  const commit = decision === "APPROVE" ? approve() : page.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true });
  // Every commit stays blocked until the changed document has been read again. A button the browser has not yet
  // taken focus from is still the active element while it is disabled: wait for the refusal to show and for the
  // commit to be ready before reading where focus is.
  await element(page.getByRole("alert")).toContainText(t("approvals.viewer.changed"));
  await element(commit).toBeEnabled();
  await element(commit).toBeFocused();
  expect(sent()).toBe(1);
  await page.keyboard.press("Enter");
  await element(receiptOf(decision)).toBeVisible();
  expect(sent()).toBe(2);
  await expect.poll(focused).toBe(recordedTitle(host));
});

test("a refusal that arrives while the person types in another control leaves focus there", async () => {
  const { release } = await open({ hold: true, refuse: true });
  await decideByKeyboard("APPROVE");
  await element(page.getByRole("article")).toHaveAttribute("aria-busy", "true");
  await find().click();
  release();
  await element(approve()).toBeEnabled();
  await page.keyboard.type("sales");
  await element(find()).toHaveValue("sales");
  expect(await focused()).toBe("INPUT");
});
