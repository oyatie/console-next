// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
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
  // A context of its own: axe opens a second page, which a browser-owned default context refuses.
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
}, 60_000);
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
 * decision, and `others` adds a second document that does. With `browse` the list keeps both documents whatever
 * they offer, as a box of every document does, and the second offers no decision.
 */
async function open({ stillOffered = false, hold = false, refuse = false, host = "page" as Host, others = false, browse = false } = {}) {
  let decided = false;
  let posts = 0;
  let revision = 1;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const withdraw = () => { decided = true; stillOffered = false; };
  const offer = () => { decided = false; };
  const document = () => decided && !stillOffered
    ? { ...served, status: { key: "APPROVED" }, my_actions: { kind: "none" } } : { ...served, revision, fingerprint: `sha256:approval-1-r${revision}` };
  // One page serves every test: each starts from a fresh load with only its own answers routed.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/approval-decision-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Approval decision</title><main id="root"></main><script type="module" src="${fixture}"></script></html>` }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1", route => route.fulfill({ json: document() }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-2", route => route.fulfill({ json: browse ? { ...other, my_actions: { kind: "none" } } : other }));
  await page.route(url => url.pathname === "/api/v1/approvals", route => {
    const items = browse ? [document(), other] : [...(document().my_actions.kind === "none" ? [] : [document()]), ...(others ? [other] : [])];
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
const column = () => page.getByRole("complementary", { name: t("approvals.document.title"), exact: true });
/** The title of the recorded card: the Console hosts dock it under a pane heading of their own. */
const recordedTitle = (host: Host) => t(host.startsWith("console") ? "approvals.console.myDecision" : "approvals.viewer.decision");
/** The line that says a decision is no longer offered. */
const withdrawn = () => page.getByRole("status").filter({ hasText: t("approvals.viewer.unavailable") });
/**
 * Sets the page's title to that line once it has been drawn, however briefly. It would be drawn where the card was,
 * so a locator that waits for the receipt cannot tell whether it was there first.
 */
const watchForWithdrawn = () => page.evaluate(line => {
  new MutationObserver(() => { if (document.body.textContent.includes(line)) document.title = line; }).observe(document.body, { childList: true, subtree: true, characterData: true });
}, t("approvals.viewer.unavailable"));
/** What the shell's live region was given last, which the fixture keeps on the body. */
const announced = () => page.locator("body").getAttribute("data-announced");
/** Coming back to the tab reads the document again. */
const readAgain = () => page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
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

test.each(["page", "console", "console-page"] as const)("on %s, a decision that someone else made meanwhile leaves a line that says so, and it takes the focus the card held", async host => {
  const { withdraw } = await open({ host });
  const opinion = page.getByRole("textbox", { name: t("approvals.viewer.opinion") });
  await opinion.focus();
  await page.keyboard.type("Looks right");
  await watchForWithdrawn();
  withdraw();
  await readAgain();
  await element(page.getByRole("article")).toHaveCount(0);
  await element(withdrawn()).toBeVisible();
  // The watcher does see the line when it is drawn: its silence after a recorded decision means something.
  await expect.poll(() => page.title()).toBe(t("approvals.viewer.unavailable"));
  await element(approve()).toHaveCount(0);
  await expect.poll(focused).toBe(t("approvals.viewer.unavailable"));
  expect(await announced(), "the focused line is read where it is, not said a second time").toBeNull();
});

test("a decision withdrawn while the person is in another control is said through the live region, and focus stays there", async () => {
  const { withdraw } = await open();
  await find().click();
  withdraw();
  await readAgain();
  await element(withdrawn()).toBeVisible();
  await expect.poll(announced).toBe(t("approvals.viewer.unavailable"));
  expect(await focused()).toBe("INPUT");
});

test("in the Console inbox, a document whose decision was withdrawn and that is opened again after one that offers none has no empty footer", async () => {
  const { withdraw } = await open({ host: "console", browse: true });
  withdraw();
  await readAgain();
  await element(withdrawn()).toBeVisible();
  await page.getByRole("row", { name: new RegExp(other.title) }).click();
  await element(column()).toContainText(other.document_no);
  await page.getByRole("row", { name: new RegExp(served.title) }).click();
  await element(column()).toContainText(served.document_no);
  // The pane's body and no footer below it: the document offers nothing now, as any decided document does.
  await element(column().locator("> div")).toHaveCount(1);
});

test("a decision that is offered again after such a line can be made, and its recorded heading takes focus", async () => {
  const { withdraw, offer } = await open();
  // The person is in another control, so the line does not take focus.
  await find().click();
  withdraw();
  await readAgain();
  await element(withdrawn()).toBeVisible();
  expect(await focused()).toBe("INPUT");
  offer();
  await readAgain();
  await approve().waitFor();
  await element(withdrawn()).toHaveCount(0);
  await decideByKeyboard("APPROVE");
  await element(receiptOf("APPROVE")).toBeVisible();
  await expect.poll(focused).toBe(recordedTitle("page"));
});

test("a decision still on its way shows no such line when the document stops offering it, and its recorded heading takes focus", async () => {
  const { release, withdraw } = await open({ hold: true });
  await decideByKeyboard("APPROVE");
  await element(page.getByRole("article")).toHaveAttribute("aria-busy", "true");
  // The same state a recorded decision passes through just before its receipt: no decision offered, none recorded yet.
  withdraw();
  await readAgain();
  await element(page.getByRole("article")).toHaveAttribute("aria-busy", "true");
  await element(page.getByRole("status")).toHaveCount(0);
  release();
  await element(receiptOf("APPROVE")).toBeVisible();
  await element(withdrawn()).toHaveCount(0);
  await expect.poll(focused).toBe(recordedTitle("page"));
});

test.each([["pending", { host: "pending" }], ["console", { host: "console", others: true }], ["console-auto", { host: "console-auto", others: true }]] as const)("on %s, Escape after a decision closes the column, and focus goes to the first row left once the decided one is gone", async (_, options) => {
  await open(options);
  await decideByKeyboard("APPROVE");
  // The decided document stays open with its receipt, also when the inbox had opened it by itself.
  await element(receiptOf("APPROVE")).toBeVisible();
  await expect.poll(focused).toBe(recordedTitle(options.host));
  await element(page.getByRole("row", { name: new RegExp(served.title) })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await element(column()).toHaveCount(0);
  await element(page.getByRole("row", { name: new RegExp(other.title) })).toBeFocused();
});

test.each([["last", { host: "last" }], ["console", { host: "console" }]] as const)("on %s, Escape after deciding the last pending document closes the column, and focus goes to the find box", async (_, options) => {
  await open(options);
  await decideByKeyboard("APPROVE");
  await expect.poll(focused).toBe(recordedTitle(options.host));
  await page.keyboard.press("Escape");
  await element(column()).toHaveCount(0);
  await element(find()).toBeFocused();
});
