// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import type { ApprovalDocument } from "../../apps/web/src/features/approvals/api";

test.beforeAll(() => loadCatalog("ko"));

const document: ApprovalDocument = {
  id: "approval-1", box: "pending", title: "영업 조직 개편안", summary: "영업1팀과 영업2팀을 하나의 조직으로 합칩니다.", document_no: "AP-2026-001",
  source: { key: "org_change", label: "조직 변경" }, status: { key: "waiting", label: "내 결재 대기", tone: "warn" },
  requester: { id: "account-1", name: "김기안", role: "인사팀" }, requested_at: "2026-11-03T01:00:00Z", due_at: "2026-11-05T01:00:00Z",
  facts: [{ key: "effective", label: "시행일", value: "2026. 11. 10." }, { key: "units", label: "대상 조직", value: "영업1팀 · 영업2팀" }],
  body: [{ key: "change", label: "변경 내용", value: "영업1팀과 영업2팀을 영업팀으로 통합" }],
  route: [
    { id: "draft", label: "기안", assignee: "김기안", state: "done", meta: "11. 3. 10:00" },
    { id: "approve", label: "인사팀장 결재", assignee: "박결재", state: "current", meta: "내 차례" },
  ],
  viewer: { kind: "org_change", id: "change-1" }, revision: 1, fingerprint: "sha256:approval-1-r1",
  consequence: "final", opinion_max: 998,
  // The server names the action and its reason catalog; the screen owns the words.
  my_actions: {
    kind: "approve",
    return: { consequence: "back_to_drafter", reason_domain: "approval_return" },
    reject: { consequence: "request_ends", reason_domain: "org_change_reject" },
  },
};
const reasonCodes: Record<string, string[]> = { approval_return: ["NEEDS_SUPPLEMENT", "OTHER"], org_change_reject: ["POLICY_VIOLATION", "OTHER"] };
const receipts = { APPROVE: "승인했습니다. 결재가 완료되었습니다.", REJECT: "반려했습니다. 결재가 끝났습니다.", RETURN: "결재를 기록했습니다." } as const;

async function mockViewer(page: Page, options: { actions?: boolean; route?: boolean; return?: boolean; stale?: boolean; holdSuccessRead?: boolean } = {}) {
  const decisions: { body: unknown; key: string | null }[] = [];
  let current = structuredClone(document);
  let reads = 0;
  let resumeRead = () => {};
  const readGate = new Promise<void>(resolveRead => { resumeRead = resolveRead; });
  let decided = false;
  if (options.actions === false) current.my_actions = { kind: "none" };
  if (options.route === false) current.route = [];
  if (options.return === false && current.my_actions.kind === "approve") delete current.my_actions.return;
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1", async route => {
    reads++;
    if (options.holdSuccessRead && decided) await readGate;
    return route.fulfill({ status: 200, json: { ...current,
      status: { key: current.status.key === "approved" ? "APPROVED" : "IN_APPROVAL" },
      route: current.route.map(step => ({ ...step, role_key: step.id === "draft" ? "hr" : "executive" })),
    } });
  });
  await page.route(url => url.pathname === "/api/v1/reason-codes", route => route.fulfill({ status: 200, json: {
    items: (reasonCodes[new URL(route.request().url()).searchParams.get("domain") ?? ""] ?? []).map(code => ({
      code, system: true, requires_note: code === "OTHER", involuntary: false, notice_required: false, active: true, label_ko: null, label_en: null })),
  } }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1/decision", async route => {
    const body = route.request().postDataJSON();
    decisions.push({ body, key: route.request().headers()["idempotency-key"] ?? null });
    if (options.stale && decisions.length === 1) {
      current = { ...current, revision: 2, fingerprint: "sha256:approval-1-r2", body: [{ key: "change", label: "변경 내용", value: "수정된 조직 개편안" }] };
      return route.fulfill({ status: 409, json: { error: { code: "approval_document_changed", message: "Document changed" } } });
    }
    decided = true;
    current = { ...current, status: { key: "approved", label: "결재 완료", tone: "ok" },
      route: current.route.map(step => ({ ...step, state: "done", meta: "결재 완료" })), my_actions: { kind: "none" } };
    const decision = (body as { decision: keyof typeof receipts }).decision;
    return route.fulfill({ status: 200, json: decision === "APPROVE" ? { decision: "APPROVED", status: "APPROVED" }
      : decision === "REJECT" ? { decision: "REJECTED", status: "REJECTED" } : { decision: "RETURNED", status: "DRAFT" } });
  });
  return { decisions, reads: () => reads, resumeRead };
}

for (const { width, theme } of [{ width: 1440, theme: "light" }, { width: 1440, theme: "dark" }, { width: 390, theme: "light" }, { width: 390, theme: "dark" }] as const) {
  test(`approval viewer shows the document before a server-decided action at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "empty");
    const { decisions, reads } = await mockViewer(page);
    await page.goto("/approvals/approval-1");

    await expect(page.getByRole("heading", { level: 1, name: document.title, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "문서 정보", exact: true })).toContainText("대상 조직");
    await expect(page.getByRole("region", { name: "결재선", exact: true })).toContainText(t("enum.approvalRole.executive"));
    await expect(page.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/change-1");
    await page.screenshot({ path: info.outputPath(`approval-viewer-${width}-${theme}-before.png`), fullPage: true });

    const chain = page.getByRole("region", { name: "결재선", exact: true });
    const body = page.getByRole("region", { name: "문서 내용", exact: true });
    expect(await chain.evaluate((el, after) => Boolean(el.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING), await body.elementHandle())).toBe(true);
    expect((await chain.boundingBox())!.y).toBeLessThan((await body.boundingBox())!.y);
    expect((await chain.boundingBox())!.y).toBeLessThan((await page.getByRole("button", { name: "승인", exact: true }).boundingBox())!.y);
    await expect(page.getByText("결재 기록에 함께 남습니다.", { exact: true })).toBeVisible();
    await expectAxe(page, `approval viewer before ${width}px ${theme}`);
    await page.getByRole("button", { name: "보완 요청", exact: true }).click();
    await expect(page.getByRole("button", { name: "보완 요청", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: "내용 보완 필요", exact: true }).press("Space");
    await expect(page.getByRole("button", { name: "보완 요청", exact: true })).toBeEnabled();
    await expectAxe(page, `approval reason form ${width}px ${theme}`);
    await page.getByRole("button", { name: "돌아가기", exact: true }).click();
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await expect(page.locator("p[role=status]", { hasText: receipts.APPROVE })).toHaveText(receipts.APPROVE);
    await expect.poll(reads).toBe(2);
    await expect(page.getByText(t("enum.orgChangeStatus.APPROVED"), { exact: true })).toBeVisible();
    await expect(chain).not.toContainText("내 차례");
    await expect(page.getByRole("textbox", { name: /^의견/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]?.body).toEqual({ decision: "APPROVE", seen_fingerprint: document.fingerprint, opinion: "" });
    expect(decisions[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    await page.screenshot({ path: info.outputPath(`approval-viewer-${width}-${theme}-after.png`), fullPage: true });
    await expectAxe(page, `approval viewer ${width}px ${theme}`);
    if (width === 390) await fits(page, "approval viewer");
    expect(mock.unexpected).toEqual([]);
  });
}

test("approval viewer never infers decision controls from document status", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "empty");
  await mockViewer(page, { actions: false });
  await page.goto("/approvals/approval-1");
  await expect(page.getByRole("heading", { level: 1, name: document.title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});

test("approval document without a route omits the route card", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "empty");
  await mockViewer(page, { actions: false, route: false });
  await page.goto("/approvals/approval-1");
  await expect(page.getByRole("region", { name: t("approvals.preview.facts"), exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: t("approvals.preview.route"), exact: true })).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});

test("approval document remains visible in the component gallery", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/_gallery?entry=approvals-page");
  const section = page.locator(".gallery__section", { has: page.getByRole("heading", { name: "결재함", exact: true }) });
  await expect(section.getByRole("region", { name: "문서 정보", exact: true })).toContainText("시행일");
  await expect(section.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
  await expect(section.getByText(t("org_change.refuse.identity_unbound"), { exact: true })).toBeVisible();
  await expectAxe(page, "approval document gallery", { include: ".gallery__section" });
  expect(await page.evaluate(() => window.document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
  expect(await page.locator("main").evaluate(main => main.scrollWidth - main.clientWidth)).toBe(0);
});

test("a changed approval is re-read before retrying with its latest fingerprint", async ({ page }) => {
  await mockScreen(page, screens[0], "empty");
  const { decisions, reads } = await mockViewer(page, { stale: true });
  await page.goto("/approvals/approval-1");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect.poll(reads).toBe(2);
  await expect(page.getByRole("region", { name: "문서 내용", exact: true })).toContainText("수정된 조직 개편안");
  await expect(page.getByText("2차 상신", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("문서가 변경되었습니다");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.locator("p[role=status]", { hasText: receipts.APPROVE })).toBeVisible();
  expect(decisions.map(d => d.body)).toEqual([
    { decision: "APPROVE", seen_fingerprint: document.fingerprint, opinion: "" },
    { decision: "APPROVE", seen_fingerprint: "sha256:approval-1-r2", opinion: "" },
  ]);
  expect(decisions[0]!.key).not.toBe(decisions[1]!.key);
});

test("request changes is absent without the server action", async ({ page }) => {
  await mockScreen(page, screens[0], "empty");
  await mockViewer(page, { return: false });
  await page.goto("/approvals/approval-1");
  await expect(page.getByRole("button", { name: "승인", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "보완 요청", exact: true })).toHaveCount(0);
});

for (const action of [
  { label: "반려", decision: "REJECT", code: "POLICY_VIOLATION", reason: "규정 위반" },
  { label: "보완 요청", decision: "RETURN", code: "NEEDS_SUPPLEMENT", reason: "내용 보완 필요" },
] as const) {
  test(`Escape closes the ${action.decision} reason form and restores focus`, async ({ page }) => {
    await mockScreen(page, screens[0], "empty");
    const { decisions } = await mockViewer(page);
    await page.goto("/approvals/approval-1");
    for (const focusOpinion of [false, true]) {
      await page.getByRole("button", { name: action.label, exact: true }).click();
      await expect(page.getByRole("radio", { name: action.reason, exact: true })).toBeVisible();
      if (focusOpinion) await page.getByRole("textbox", { name: /^의견/ }).focus();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("radio")).toHaveCount(0);
      await expect(page.getByRole("button", { name: action.label, exact: true })).toBeFocused();
    }
    expect(decisions).toEqual([]);
  });
  for (const other of [false, true]) test(`${action.decision} submits ${other ? "OTHER with a memo" : "the reason code"}`, async ({ page }) => {
    await mockScreen(page, screens[0], "empty");
    const { decisions } = await mockViewer(page);
    await page.goto("/approvals/approval-1");
    await page.getByRole("textbox", { name: /^의견/ }).fill(" 검토 의견 ");
    await page.getByRole("button", { name: action.label, exact: true }).click();
    const commit = page.getByRole("button", { name: action.label, exact: true });
    await expect(commit).toBeDisabled();
    await page.getByRole("radio", { name: other ? "기타" : action.reason, exact: true }).press("Space");
    if (other) {
      await expect(commit).toBeDisabled();
      await page.getByRole("textbox", { name: /^메모/ }).fill(" 보완할 내용을 확인했습니다. ");
    }
    await commit.click();
    await expect(page.locator("p[role=status]", { hasText: receipts[action.decision] })).toBeVisible();
    expect(decisions[0]?.body).toEqual({ decision: action.decision, seen_fingerprint: document.fingerprint, opinion: "검토 의견",
      reason_code: other ? "OTHER" : action.code, ...(other ? { note: "보완할 내용을 확인했습니다." } : {}) });
    expect(decisions[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });
}

test("the receipt waits for the updated document", async ({ page }) => {
  await mockScreen(page, screens[0], "empty");
  const { reads, resumeRead } = await mockViewer(page, { holdSuccessRead: true });
  await page.goto("/approvals/approval-1");
  const approve = page.getByRole("button", { name: "승인", exact: true });
  await approve.click();
  await expect.poll(reads).toBe(2);
  await expect(approve).toBeDisabled();
  await expect(page.locator("p[role=status]", { hasText: receipts.APPROVE })).toHaveCount(0);
  resumeRead();
  await expect(page.locator("p[role=status]", { hasText: receipts.APPROVE })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^의견/ })).toHaveCount(0);
});
