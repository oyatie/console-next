// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

const document = {
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
  consequence: "승인하면 조직 변경이 시행일에 반영됩니다.", opinion_max: 1000,
  my_actions: {
    kind: "approve",
    return: { consequence: "같은 문서가 기안자에게 돌아갑니다.", reason: { codes: [{ code: "CONTENT", label: "내용 보완 필요" }, { code: "OTHER", label: "기타" }], other: "OTHER", memo_max: 1000 } },
    reject: { consequence: "문서가 종결되며 다시 진행하려면 재기안해야 합니다.", reason: { codes: [{ code: "POLICY", label: "정책에 맞지 않음" }, { code: "OTHER", label: "기타" }], other: "OTHER", memo_max: 1000 } },
  },
} as const;

async function mockViewer(page: Page, actions = true) {
  const decisions: { body: unknown; key: string | null }[] = [];
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1", route => route.fulfill({ status: 200, json: actions ? document : { ...document, my_actions: { kind: "none" } } }));
  await page.route(url => url.pathname === "/api/v1/approvals/approval-1/decision", async route => {
    if (route.request().method() === "POST") {
      decisions.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] ?? null });
      return route.fulfill({ status: 200, json: { message: "승인했습니다." } });
    }
    return route.fallback();
  });
  return decisions;
}

for (const { width, theme } of [{ width: 1440, theme: "light" }, { width: 390, theme: "dark" }] as const) {
  test(`approval viewer shows the document before a server-decided action at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "empty");
    const decisions = await mockViewer(page);
    await page.goto("/approvals/approval-1");

    await expect(page.getByRole("heading", { level: 1, name: document.title, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "결정 요약", exact: true })).toContainText("대상 조직");
    await expect(page.getByRole("region", { name: "결재선", exact: true })).toContainText("인사팀장 결재");
    await expect(page.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/change-1");
    await page.screenshot({ path: info.outputPath(`approval-viewer-${width}-${theme}-before.png`), fullPage: true });

    await page.getByRole("button", { name: "보완 요청", exact: true }).click();
    await expect(page.getByRole("button", { name: "보완 요청", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: "내용 보완 필요", exact: true }).press("Space");
    await expect(page.getByRole("button", { name: "보완 요청", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await expect(page.locator("p[role=status]", { hasText: "승인했습니다." })).toHaveText("승인했습니다.");
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
  await mockViewer(page, false);
  await page.goto("/approvals/approval-1");
  await expect(page.getByRole("heading", { level: 1, name: document.title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});

test("approval document remains visible in the component gallery", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/_gallery?entry=approvals-page");
  const section = page.locator(".gallery__section", { has: page.getByRole("heading", { name: "결재함", exact: true }) });
  await expect(section.getByRole("region", { name: "결정 요약", exact: true })).toContainText("시행일");
  await expect(section.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
  await expectAxe(page, "approval document gallery", { include: ".gallery__section" });
  expect(await page.evaluate(() => window.document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
  expect(await page.locator("main").evaluate(main => main.scrollWidth - main.clientWidth)).toBe(0);
});
