// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { screens } from "../states/registry";
import { failure } from "./fixtures";
import { mockRoute } from "./route";
import {
  saeonAdminToken,
  saeonAdminUser,
  saeonApprovalDocument,
  saeonApprovalsPage,
  saeonUniverse,
  saeonWorklistInbox,
} from "./saeon";
import { screenAccess } from "./fixtures";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function enableConsoleExperience(page: Page, theme: "light" | "dark" = "light", locale: "ko" | "en" = "ko") {
  await page.addInitScript(
    ({ expKey, themeValue, localeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", localeValue);
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme, localeValue: locale },
  );
}

async function setupConsoleApprovals(
  page: Page,
  theme: "light" | "dark" = "light",
  locale: "ko" | "en" = "ko",
  options: {
    staleOnFirst?: boolean;
    staleToNone?: boolean;
    holdStaleDocRefetch?: boolean;
    holdDecisionPost?: boolean;
    listDelayAfterDecisionMs?: number;
    refuseDecision?: boolean;
    docOverrides?: Partial<ReturnType<typeof saeonApprovalDocument>>;
  } = {},
) {
  await enableConsoleExperience(page, theme, locale);
  const fixture = await mockScreen(page, screens[0], "empty");
  const accessRoutes = ["/org", "/people", "/attendance", "/settings"].map(path => screenAccess(path));
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: {
      ...accessRoutes[0]!,
      entries: accessRoutes.flatMap(entry => entry.entries),
    },
  });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: saeonWorklistInbox() });

  let currentDoc = { ...saeonApprovalDocument(saeonUniverse.approval.documentNumber), ...options.docOverrides };
  let decisionAttempts = 0;
  let decided = false;
  let staleHeld = false;
  let releaseStaleDoc = () => {};
  let staleDocGate = new Promise<void>(resolve => {
    releaseStaleDoc = resolve;
  });
  let releaseDecisionPost = () => {};
  const decisionPostGate = new Promise<void>(resolve => {
    releaseDecisionPost = resolve;
  });

  await mockRoute(page, "get", "/api/v1/approvals", async request => {
    if (decided && options.listDelayAfterDecisionMs) {
      await new Promise(resolve => setTimeout(resolve, options.listDelayAfterDecisionMs));
    }
    const query = new URL(request.url()).searchParams;
    const box = (query.get("box") ?? "pending") as Parameters<typeof saeonApprovalsPage>[0];
    return {
      status: 200,
      json: saeonApprovalsPage(box, {
        q: query.get("q") ?? undefined,
        source: query.get("source") ?? undefined,
      }),
    };
  });

  await mockRoute(page, "get", "/api/v1/approvals/{id}", async request => {
    const docId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
    if (docId === saeonUniverse.approval.documentNumber) {
      if (staleHeld) await staleDocGate;
      return { status: 200, json: currentDoc };
    }
    return { status: 200, json: saeonApprovalDocument(docId) };
  });

  await mockRoute(page, "get", "/api/v1/reason-codes", request => {
    const domain = new URL(request.url()).searchParams.get("domain") ?? "";
    const codes = domain === "approval_return" ? ["NEEDS_SUPPLEMENT", "OTHER"] : ["POLICY_VIOLATION", "OTHER"];
    return {
      status: 200,
      json: {
        domain,
        items: codes.map(code => ({
          code,
          system: true,
          requires_note: code === "OTHER",
          involuntary: false,
          notice_required: false,
          active: true,
          label_ko: null,
          label_en: null,
        })),
      },
    };
  });

  const decisions: { body: unknown; key: string | null }[] = [];
  await mockRoute(page, "post", "/api/v1/approvals/{id}/decision", async request => {
    const body = request.postDataJSON() as { decision: "APPROVE" | "REJECT" | "RETURN" };
    decisions.push({ body, key: request.headers()["idempotency-key"] ?? null });
    decisionAttempts++;
    if (options.holdDecisionPost) {
      await decisionPostGate;
    }
    if (options.refuseDecision) {
      return { status: 403, json: failure("forbidden") };
    }
    if (options.staleOnFirst && decisionAttempts === 1) {
      if (options.holdStaleDocRefetch) {
        staleHeld = true;
      }
      currentDoc = {
        ...currentDoc,
        revision: 2,
        fingerprint: "sha256:saeon-oc-2026-0418-r2",
        summary: `${saeonUniverse.approval.reason} (v2)`,
        ...(options.staleToNone ? { my_actions: { kind: "none" } } : {}),
      };
      return { status: 409, json: failure("approval_document_changed") };
    }
    decided = true;
    currentDoc = {
      ...currentDoc,
      status: { key: body.decision === "REJECT" ? "REJECTED" : "APPROVED" },
      route: currentDoc.route.map(step => ({ ...step, state: "done" })),
      my_actions: { kind: "none" },
    };
    return {
      status: 200,
      json:
        body.decision === "APPROVE"
          ? { decision: "APPROVED", status: "APPROVED" }
          : body.decision === "REJECT"
            ? { decision: "REJECTED", status: "REJECTED" }
            : { decision: "RETURNED", status: "DRAFT" },
    };
  });

  return {
    fixture,
    decisions,
    releaseStaleDoc: () => {
      staleHeld = false;
      releaseStaleDoc();
    },
    releaseDecisionPost,
  };
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /approvals renders compact queue and split view at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupConsoleApprovals(page, theme);
      try {
        await page.goto("/approvals");
        const worklist = page.locator('[data-pattern="worklist"]');
        await expect(worklist).toBeVisible();
        const tabs = page.getByRole("navigation", { name: t("approvals.tabs"), exact: true });
        await expect(tabs.getByRole("link")).toHaveCount(5);

        const table = worklist.getByRole("grid", { name: t("approvals.list"), exact: true });
        await expect(table.locator("tbody tr[data-id]")).toHaveCount(6);
        await expect(worklist.locator(".card")).toHaveCount(0);
        await expect(table.getByRole("list", { name: t("approvals.preview.route"), exact: true })).toHaveCount(0);
        await expect(table.locator(`tbody tr[data-id="AP-2026-0419"]`)).toContainText(t("approvals.source.leave"));
        const kpiStrip = worklist.locator(`dl[aria-label="${t("approvals.console.kpiLabel")}"]`);
        await expect(kpiStrip).toBeVisible();
        await expect(kpiStrip.getByRole("button")).toHaveCount(6);

        if (width === 1440) {
          const initialSidePane = page.locator('aside[data-pane="record"]');
          await expect(initialSidePane).toBeVisible();
          await expect(initialSidePane).toContainText(`${t("home.worklist.selectedMeta")} · ${saeonUniverse.approval.documentNumber}`);
          await expect(initialSidePane).toContainText(saeonUniverse.approval.title);
          const relatedHeading = initialSidePane.getByRole("heading", { level: 3, name: t("approvals.related.title"), exact: true });
          const approveBtn = initialSidePane.getByRole("button", { name: t("composer.verb.approve"), exact: true });
          const rejectBtn = initialSidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true });
          await expect(relatedHeading).toBeVisible();
          await expect(approveBtn).toBeVisible();
          await expect(rejectBtn).toBeVisible();
          const paneScrollBox = await initialSidePane.locator('[tabindex="0"]').first().boundingBox();
          const relatedBox = await relatedHeading.boundingBox();
          const relatedLastLinkBox = await initialSidePane.getByRole("link", { name: new RegExp(t("approvals.openSource")) }).boundingBox();
          const approveBox = await approveBtn.boundingBox();
          const rejectBox = await rejectBtn.boundingBox();
          expect(paneScrollBox).not.toBeNull();
          expect(relatedBox).not.toBeNull();
          expect(relatedLastLinkBox).not.toBeNull();
          expect(approveBox).not.toBeNull();
          expect(rejectBox).not.toBeNull();
          expect(relatedBox!.y + relatedBox!.height).toBeLessThanOrEqual(paneScrollBox!.y + paneScrollBox!.height + 1);
          expect(relatedLastLinkBox!.y + relatedLastLinkBox!.height).toBeLessThanOrEqual(paneScrollBox!.y + paneScrollBox!.height + 1);
          expect(approveBox!.y + approveBox!.height).toBeLessThanOrEqual(876);
          expect(rejectBox!.y + rejectBox!.height).toBeLessThanOrEqual(876);
        } else {
          await expect(page.locator('aside[data-pane="record"]')).toHaveCount(0);
        }

        if (width === 390) {
          const rowHeights = await table.locator("tbody tr[data-id]").evaluateAll(rows =>
            rows.map(r => {
              const rect = r.getBoundingClientRect();
              return { height: Math.round(rect.height), bottom: Math.round(rect.bottom) };
            }),
          );
          expect(rowHeights.every(r => r.height >= 48 && r.height <= 68)).toBe(true);
          expect(rowHeights.filter(r => r.bottom <= 900).length).toBeGreaterThanOrEqual(6);
          const completedTabBox = await tabs.getByRole("link", { name: new RegExp(t("approvals.box.completed")) }).boundingBox();
          expect(completedTabBox).not.toBeNull();
          expect(completedTabBox!.x + completedTabBox!.width).toBeLessThanOrEqual(390);
        }

        await withFullPage(page, () => shot(page, `approvals--${width}-${theme}`));
        if (width === 1440) {
          const statusBar = page.getByRole("contentinfo").last();
          const barBox = await statusBar.boundingBox();
          expect(barBox).not.toBeNull();
          expect(barBox!.y + barBox!.height).toBeGreaterThanOrEqual(899);
        } else {
          const phoneNav = page.locator('[data-console-shell] nav').last();
          const navBox = await phoneNav.boundingBox();
          expect(navBox).not.toBeNull();
          expect(navBox!.y + navBox!.height).toBeGreaterThanOrEqual(899);
        }
        await fits(page, `Console /approvals ${width} ${theme}`);
        await expectAxe(page, `Console /approvals ${width} ${theme}`);

        const targetRow = table.locator(`tbody tr[data-id="${saeonUniverse.approval.documentNumber}"]`);
        await targetRow.click();

        const sidePane = page.locator('aside[data-pane="record"]');
        await expect(sidePane).toBeVisible();
        await expect(sidePane).toContainText(saeonUniverse.approval.title);
        await expect(sidePane).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.departments[2]!.split(" › ").at(-1)!);
        await expect(sidePane).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.departments[3]!.split(" › ").at(-1)!);
        await expect(sidePane.locator("article")).toBeVisible();

        await fits(page, `Console /approvals split ${width} ${theme}`);
        await expectAxe(page, `Console /approvals split ${width} ${theme}`);

        const closeBtn = sidePane.getByRole("button", { name: t(width === 390 ? "common.back" : "common.closePanel"), exact: true });
        await closeBtn.click();
        await expect(sidePane).toHaveCount(0);
        await expect(targetRow).toBeFocused();

        if (width === 1440) {
          await kpiStrip.getByRole("button", { name: t("approvals.source.leave"), exact: true }).click();
          await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
          await expect(table.locator('tbody tr[data-id="AP-2026-0419"]')).toBeVisible();
          await expect(sidePane).toBeVisible();
          await expect(sidePane).toContainText("AP-2026-0419");
          await kpiStrip.getByRole("button", { name: t("approvals.console.all"), exact: true }).click();
          await expect(table.locator("tbody tr[data-id]")).toHaveCount(6);
          await expect(sidePane).toContainText(saeonUniverse.approval.documentNumber);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });

    test(`Console /approvals/$approvalId renders P4 DocumentDecision at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupConsoleApprovals(page, theme);
      try {
        await page.goto("/approvals");
        const firstRow = page.getByRole("grid", { name: t("approvals.list"), exact: true }).locator(`tbody tr[data-id="${saeonUniverse.approval.documentNumber}"]`);
        await firstRow.getByRole("link", { name: t("home.inbox.open"), exact: true }).click();
        const pattern = page.locator('[data-pattern="document-decision"]');
        await expect(pattern).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("approvals.console.title"), exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: saeonUniverse.approval.title, exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: t("approvals.preview.facts"), exact: true })).toContainText(saeonUniverse.approval.documentNumber);
        const routeRegion = page.getByRole("region", { name: t("approvals.preview.route"), exact: true });
        await expect(routeRegion).toContainText(saeonUniverse.approval.steps[1]!.actor);
        await expect(routeRegion).toContainText(t("enum.approvalRole.hr"));
        await expect(routeRegion).not.toContainText(t("enum.approvalRole.finance"));
        await expect(page.getByRole("main").getByText(t("approvals.console.queuePos", { n: 1, total: 6 }), { exact: true })).toBeVisible();

        const proposalSection = page.getByRole("region", { name: t("approvals.field.proposal"), exact: true });
        await expect(proposalSection).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.departments[2]!.split(" › ").at(-1)!);
        await expect(proposalSection).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.departments[3]!.split(" › ").at(-1)!);
        const diffPairs = await proposalSection.locator("[data-change-rows] > div").evaluateAll(rows =>
          rows.map(row => ({
            subject: row.querySelector("dt")?.textContent?.trim(),
            before: row.querySelector("dd")?.textContent?.trim(),
          })),
        );
        expect(diffPairs.length).toBeGreaterThan(0);
        for (const pair of diffPairs) {
          expect(pair.subject).not.toBe(pair.before);
        }

        const aside = pattern.locator("aside");
        await expect(aside).toBeVisible();
        await expect(aside.getByRole("heading", { level: 3, name: t("approvals.related.title"), exact: true })).toBeVisible();
        await expect(aside.getByRole("link", { name: new RegExp(t("approvals.openSource")) })).toBeVisible();
        const cardBorder = await aside.locator("article").evaluate(el => getComputedStyle(el).borderStyle);
        expect(cardBorder).toBe("none");

        await withFullPage(page, () => shot(page, `approval--${width}-${theme}`));
        await fits(page, `Console /approvals/$approvalId ${width} ${theme}`);
        await expectAxe(page, `Console /approvals/$approvalId ${width} ${theme}`);

        if (width === 1440) {
          const nextLink = page.getByRole("link", { name: t("approvals.console.nextDoc"), exact: true });
          await nextLink.click();
          await expect(page).toHaveURL(/\/approvals\/AP-2026-0419/);
          await expect(page.getByRole("main").getByText(t("approvals.console.queuePos", { n: 2, total: 6 }), { exact: true })).toBeVisible();
        }
        if (width === 390) {
          await page.setViewportSize({ width: 320, height: 900 });
          await fits(page, `Console /approvals/$approvalId 320 ${theme}`);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /approvals/$approvalId supports D6 receipt focus, required reject reason + OTHER memo, Escape, 409 conflict, 403 refusal, and read-only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. D6 receipt focus & optional opinion approve
  {
    const { fixture, decisions } = await setupConsoleApprovals(page, "light");
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      await page.getByRole("button", { name: t("composer.verb.approve"), exact: true }).click();
      const article = page.getByRole("article", { name: t("approvals.console.myDecision"), exact: true });
      const heading = article.getByRole("heading", { level: 2, name: t("approvals.console.myDecision"), exact: true });
      await expect(heading).toBeFocused();
      await expect(article.getByRole("status")).toHaveText(t("approvals.receipt.approvedFinal"));
      await expect(article.getByRole("link", { name: t("approvals.title"), exact: true })).toHaveAttribute("href", "/approvals");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.body).toEqual({
        decision: "APPROVE",
        seen_fingerprint: "sha256:saeon-oc-2026-0418-r1",
        opinion: "",
      });
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // 2. Reject reason flow + OTHER memo + Escape preserving opinion
  {
    const { fixture, decisions } = await setupConsoleApprovals(page, "light");
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      const opinionBox = page.getByRole("textbox", { name: new RegExp(`^${t("approvals.viewer.opinion")}`) });
      await opinionBox.fill("  review note  ");
      await page.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true })).toBeFocused();
      await expect(opinionBox).toHaveValue("  review note  ");

      await page.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true }).click();
      const commit = page.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true });
      await expect(commit).toBeDisabled();
      await page.getByRole("radio", { name: t("empFix.reason.OTHER"), exact: true }).press("Space");
      await expect(commit).toBeDisabled();
      await page.getByRole("textbox", { name: new RegExp(`^${t("uiReason.memo")}`) }).fill("  checked  ");
      await expect(commit).toBeEnabled();
      await commit.click();
      await expect(page.locator("p[role=status]", { hasText: t("approvals.receipt.rejected") })).toBeVisible();
      expect(decisions[0]?.body).toEqual({
        decision: "REJECT",
        seen_fingerprint: "sha256:saeon-oc-2026-0418-r1",
        opinion: "review note",
        reason_code: "OTHER",
        note: "checked",
      });
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // 3. 409 stale conflict preserves typed opinion and retries with new fingerprint
  {
    const { fixture, decisions } = await setupConsoleApprovals(page, "light", "ko", { staleOnFirst: true });
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      const opinionBox = page.getByRole("textbox", { name: new RegExp(`^${t("approvals.viewer.opinion")}`) });
      await opinionBox.fill("keep my opinion");
      await page.getByRole("button", { name: t("composer.verb.approve"), exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(t("approvals.viewer.changed"));
      await expect(opinionBox).toHaveValue("keep my opinion");
      await expect(page.getByText(new RegExp(t("approvals.viewer.revision", { revision: 2 })))).toBeVisible();
      await page.getByRole("button", { name: t("composer.verb.approve"), exact: true }).click();
      await expect(page.locator("p[role=status]", { hasText: t("approvals.receipt.approvedFinal") })).toBeVisible();
      expect(decisions).toHaveLength(2);
      expect(decisions[1]?.body).toEqual({
        decision: "APPROVE",
        seen_fingerprint: "sha256:saeon-oc-2026-0418-r2",
        opinion: "keep my opinion",
      });
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // 4. 403 Cedar refusal on command & read-only decision_refusal / my_actions.kind = none
  {
    const { fixture } = await setupConsoleApprovals(page, "light", "ko", { refuseDecision: true });
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      await page.getByRole("button", { name: t("composer.verb.approve"), exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expectAxe(page, "Console approval 403 command refusal");
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  {
    const { fixture } = await setupConsoleApprovals(page, "light", "ko", {
      docOverrides: {
        decision_refusal: "org_change.refuse.identity_unbound",
        my_actions: { kind: "none" },
      },
    });
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      const facts = page.getByRole("region", { name: t("approvals.preview.facts"), exact: true });
      await expect(facts.getByText(t("org_change.refuse.identity_unbound"), { exact: true })).toBeVisible();
      await expect(page.locator('[data-pattern="document-decision"] aside')).toHaveCount(0);
      await expectAxe(page, "Console approval read-only refusal");
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }
});

test("Console /approvals renders in English locale with search, filter, and reset", async ({ page }) => {
  await loadCatalog("en");
  i18n.set("en");
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleApprovals(page, "light", "en");
  try {
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { level: 1, name: t("approvals.title"), exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: t("approvals.filters.search"), exact: true }).fill("0418");
    const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
    await expect(grid.locator("tbody tr[data-id]")).toHaveCount(1);
    await page.getByRole("button", { name: t("approvals.filters.reset"), exact: true }).click();
    await expect(grid.locator("tbody tr[data-id]")).toHaveCount(6);
    await expectAxe(page, "Console /approvals en");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    i18n.set("ko");
    await loadCatalog("ko");
    fixture.release();
  }
});

test("Console /approvals?sel=... preserves D6 focus under 150ms list settle delay, blocks 409 REJECT retries, keeps 409 alert on none, and ignores Escape while busy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. D6 receipt focus race with 150ms delayed list refetch
  {
    const { fixture } = await setupConsoleApprovals(page, "light", "ko", { listDelayAfterDecisionMs: 150 });
    try {
      await page.goto(`/approvals?sel=${saeonUniverse.approval.documentNumber}`);
      const sidePane = page.locator('aside[data-pane="record"]');
      await sidePane.getByRole("button", { name: t("composer.verb.approve"), exact: true }).click();
      const article = sidePane.getByRole("article", { name: t("approvals.console.myDecision"), exact: true });
      await expect(article.getByRole("status")).toHaveText(t("approvals.receipt.approvedFinal"));
      await expect(article.getByRole("heading", { level: 2, name: t("approvals.console.myDecision"), exact: true })).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // 2. 409 on REJECT disables commit button while r1 refetch is held, and preserves 409 alert if refetch returns my_actions=none
  {
    const { fixture, releaseStaleDoc } = await setupConsoleApprovals(page, "light", "ko", {
      staleOnFirst: true,
      staleToNone: true,
      holdStaleDocRefetch: true,
    });
    try {
      await page.goto(`/approvals?sel=${saeonUniverse.approval.documentNumber}`);
      const sidePane = page.locator('aside[data-pane="record"]');
      await sidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true }).click();
      await sidePane.getByRole("radio", { name: t("empFix.reason.OTHER"), exact: true }).press("Space");
      await sidePane.getByRole("textbox", { name: new RegExp(`^${t("uiReason.memo")}`) }).fill("conflict check");
      const commit = sidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true });
      await commit.click();
      await expect(sidePane.getByRole("alert")).toContainText(t("approvals.viewer.changed"));
      await expect(commit).toBeDisabled();
      releaseStaleDoc();
      await expect(sidePane.getByRole("alert")).toContainText(t("approvals.viewer.changed"));
      expect(fixture.unexpected).toEqual([]);
    } finally {
      releaseStaleDoc();
      fixture.release();
    }
  }

  // 3. Escape while REJECT is busy does not close side pane
  {
    const { fixture, releaseDecisionPost } = await setupConsoleApprovals(page, "light", "ko", { holdDecisionPost: true });
    try {
      await page.goto(`/approvals?sel=${saeonUniverse.approval.documentNumber}`);
      const sidePane = page.locator('aside[data-pane="record"]');
      await sidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true }).click();
      await sidePane.getByRole("radio", { name: t("empFix.reason.OTHER"), exact: true }).press("Space");
      await sidePane.getByRole("textbox", { name: new RegExp(`^${t("uiReason.memo")}`) }).fill("busy escape");
      await sidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true }).click();
      await expect(sidePane.locator('article[aria-busy="true"]')).toBeVisible();
      await sidePane.locator('[tabindex="0"]').first().focus();
      await page.keyboard.press("Escape");
      await expect(sidePane).toHaveCount(1);
      releaseDecisionPost();
      await expect(sidePane.getByRole("status")).toHaveText(t("approvals.receipt.rejected"));
      expect(fixture.unexpected).toEqual([]);
    } finally {
      releaseDecisionPost();
      fixture.release();
    }
  }
});

test("Console /approvals and viewer fit cleanly at 320px/390px in ko & en, and omit empty aside/dl", async ({ page }) => {
  // 1. 320x844 SidePane zero overflow in ko & en
  for (const locale of ["ko", "en"] as const) {
    await loadCatalog(locale);
    i18n.set(locale);
    await page.setViewportSize({ width: 320, height: 844 });
    const { fixture } = await setupConsoleApprovals(page, "light", locale);
    try {
      await page.goto(`/approvals?sel=${saeonUniverse.approval.documentNumber}`);
      const sidePane = page.locator('aside[data-pane="record"]');
      await expect(sidePane).toBeVisible();
      const overflow = await sidePane.evaluate(el => el.scrollWidth - el.clientWidth);
      expect(overflow, `320px SidePane overflow (${locale})`).toBeLessThanOrEqual(0);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // 2. 390x844 en PageHead h1 zero clipping
  await loadCatalog("en");
  i18n.set("en");
  await page.setViewportSize({ width: 390, height: 844 });
  {
    const { fixture } = await setupConsoleApprovals(page, "light", "en");
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      const h1 = page.getByRole("heading", { level: 1, name: t("approvals.console.title"), exact: true });
      await expect(h1).toBeVisible();
      const h1Clip = await h1.evaluate(el => el.scrollWidth - el.clientWidth);
      expect(h1Clip, "390px en PageHead h1 clip").toBeLessThanOrEqual(0);
      await fits(page, "Console en /approvals/$approvalId 390px");
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // 3. approve without reject omits dead empty <aside>, and summary-only side view omits empty <dl>
  await loadCatalog("ko");
  i18n.set("ko");
  await page.setViewportSize({ width: 1440, height: 900 });
  {
    const { fixture } = await setupConsoleApprovals(page, "light", "ko", {
      docOverrides: { my_actions: { kind: "approve" }, body: [], proposal: [], proposal_names: {} },
    });
    try {
      await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
      await expect(page.locator('[data-pattern="document-decision"] aside')).toHaveCount(0);
      await page.goto(`/approvals?sel=${saeonUniverse.approval.documentNumber}`);
      const sidePane = page.locator('aside[data-pane="record"]');
      await expect(sidePane).toBeVisible();
      const emptyDls = await sidePane.locator("dl").evaluateAll(dls => dls.filter(dl => dl.children.length === 0).length);
      expect(emptyDls).toBe(0);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }
});

test("Console /approvals/$approvalId DocQueueStepper avoids multi-query concatenation self-loops and inflated totals across filter/search transitions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // (a) /approvals?q=0418 -> reset filters -> open OC-2026-0418 -> 1 of 6 -> Next goes to AP-2026-0419 (not self-loop)
  {
    let listRequestsOnViewer = 0;
    const { fixture } = await setupConsoleApprovals(page, "light", "ko");
    try {
      await page.goto("/approvals?q=0418");
      const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(1);

      await page.getByRole("button", { name: t("approvals.filters.reset"), exact: true }).click();
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(6);

      await grid.locator(`tbody tr[data-id="${saeonUniverse.approval.documentNumber}"]`).getByRole("link", { name: t("home.inbox.open"), exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/approvals/${saeonUniverse.approval.documentNumber}$`));
      await expect(page.getByRole("main").getByText(t("approvals.console.queuePos", { n: 1, total: 6 }), { exact: true })).toBeVisible();
      await expect(page.getByRole("contentinfo").last().getByText(t("approvals.console.queuePos", { n: 1, total: 6 }), { exact: true })).toBeVisible();

      const nextLink = page.getByRole("link", { name: t("approvals.console.nextDoc"), exact: true });
      await expect(nextLink).toHaveAttribute("href", "/approvals/AP-2026-0419");

      page.on("request", req => {
        if (new URL(req.url()).pathname === "/api/v1/approvals") listRequestsOnViewer++;
      });
      await nextLink.click();
      await expect(page).toHaveURL(/\/approvals\/AP-2026-0419$/);
      await expect(page.getByRole("main").getByText(t("approvals.console.queuePos", { n: 2, total: 6 }), { exact: true })).toBeVisible();
      expect(listRequestsOnViewer).toBe(0);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // (b) /approvals -> search "0419" -> open AP-2026-0419 -> 1 of 1 (no 7-item inflation, Next disabled)
  {
    const { fixture } = await setupConsoleApprovals(page, "light", "ko");
    try {
      await page.goto("/approvals");
      const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(6);

      await page.getByRole("searchbox", { name: t("approvals.filters.search"), exact: true }).fill("0419");
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(1);

      await grid.locator('tbody tr[data-id="AP-2026-0419"]').getByRole("link", { name: t("home.inbox.open"), exact: true }).click();
      await expect(page).toHaveURL(/\/approvals\/AP-2026-0419$/);
      await expect(page.getByRole("main").getByText(t("approvals.console.queuePos", { n: 1, total: 1 }), { exact: true })).toBeVisible();
      await expect(page.getByRole("contentinfo").last().getByText(t("approvals.console.queuePos", { n: 1, total: 1 }), { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: t("approvals.console.nextDoc"), exact: true })).toBeDisabled();
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }

  // (c) /approvals -> search "0418" -> reset filters (within staleTime cache) -> open OC-2026-0418 -> 1 of 6 -> Next goes to AP-2026-0419
  {
    const { fixture } = await setupConsoleApprovals(page, "light", "ko");
    try {
      await page.goto("/approvals");
      const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(6);

      await page.getByRole("searchbox", { name: t("approvals.filters.search"), exact: true }).fill("0418");
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(1);

      await page.getByRole("button", { name: t("approvals.filters.reset"), exact: true }).click();
      await expect(grid.locator("tbody tr[data-id]")).toHaveCount(6);

      await grid.locator(`tbody tr[data-id="${saeonUniverse.approval.documentNumber}"]`).getByRole("link", { name: t("home.inbox.open"), exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/approvals/${saeonUniverse.approval.documentNumber}$`));
      await expect(page.getByRole("main").getByText(t("approvals.console.queuePos", { n: 1, total: 6 }), { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: t("approvals.console.nextDoc"), exact: true })).toHaveAttribute("href", "/approvals/AP-2026-0419");
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }
});

test("Console /approvals KPI tile transitions work from category source -> needs-check -> all", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleApprovals(page, "light");
  await mockRoute(page, "get", "/api/v1/approvals", request => {
    const query = new URL(request.url()).searchParams;
    const box = (query.get("box") ?? "pending") as Parameters<typeof saeonApprovalsPage>[0];
    const base = saeonApprovalsPage(box, {
      q: query.get("q") ?? undefined,
      source: query.get("source") ?? undefined,
    });
    return {
      status: 200,
      json: {
        ...base,
        items: base.items.map(item =>
          item.id === "AP-2026-0419" || item.id === "AP-2026-0420"
            ? { ...item, decision_refusal: "org_change.refuse.identity_unbound" }
            : item,
        ),
      },
    };
  });
  try {
    await page.goto("/approvals");
    const worklist = page.locator('[data-pattern="worklist"]');
    const table = worklist.getByRole("grid", { name: t("approvals.list"), exact: true });
    const kpiStrip = worklist.locator(`dl[aria-label="${t("approvals.console.kpiLabel")}"]`);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(6);

    await kpiStrip.getByRole("button", { name: t("approvals.source.leave"), exact: true }).click();
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await expect(table.locator('tbody tr[data-id="AP-2026-0419"]')).toBeVisible();

    const needsCheckBtn = kpiStrip.getByRole("button", { name: t("approvals.console.needsCheck"), exact: true });
    await needsCheckBtn.click();
    await expect(needsCheckBtn).toHaveAttribute("aria-pressed", "true");
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(2);
    await expect(table.locator('tbody tr[data-id="AP-2026-0419"]')).toBeVisible();
    await expect(table.locator('tbody tr[data-id="AP-2026-0420"]')).toBeVisible();

    await kpiStrip.getByRole("button", { name: t("approvals.console.all"), exact: true }).click();
    await expect(needsCheckBtn).toHaveAttribute("aria-pressed", "false");
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(6);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /approvals keeps .paneBody readable and .paneFooter scrollable on 409 REJECT at 1280x720 and 1366x768", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const { fixture } = await setupConsoleApprovals(page, "light", "ko", { staleOnFirst: true });
    try {
      await page.goto("/approvals");
      const sidePane = page.locator('aside[data-pane="record"]');
      await expect(sidePane).toBeVisible();
      await sidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true }).click();
      await sidePane.getByRole("radio", { name: t("reason.org_change_reject.POLICY_VIOLATION"), exact: true }).press("Space");
      const commit = sidePane.getByRole("button", { name: t("uiApprovalCard.reject"), exact: true });
      await commit.scrollIntoViewIfNeeded();
      await commit.click();

      await expect(sidePane.getByRole("alert")).toContainText(t("approvals.viewer.changed"));

      const paneBody = sidePane.locator('[tabindex="0"]').first();
      const paneFooter = sidePane.locator("article").locator("xpath=..");
      const footerScrollable = await paneFooter.evaluate(el => {
        el.scrollTop = el.scrollHeight;
        return el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto";
      });
      expect(footerScrollable, `${viewport.width}x${viewport.height} .paneFooter scrollable`).toBe(true);

      const asideBox = await sidePane.boundingBox();
      const bodyBox = await paneBody.boundingBox();
      const footerBox = await paneFooter.boundingBox();
      const commitBox = await commit.boundingBox();

      expect(asideBox).not.toBeNull();
      expect(bodyBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect(commitBox).not.toBeNull();

      expect(bodyBox!.height, `${viewport.width}x${viewport.height} .paneBody height`).toBeGreaterThanOrEqual(80);
      expect(footerBox!.y + footerBox!.height, `${viewport.width}x${viewport.height} .paneFooter bottom`).toBeLessThanOrEqual(
        asideBox!.y + asideBox!.height + 1,
      );
      expect(commitBox!.y, `${viewport.width}x${viewport.height} commit top inside footer`).toBeGreaterThanOrEqual(footerBox!.y - 1);
      expect(
        commitBox!.y + commitBox!.height,
        `${viewport.width}x${viewport.height} commit bottom inside footer`,
      ).toBeLessThanOrEqual(footerBox!.y + footerBox!.height + 1);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  }
});

test("Console /approvals full-screen button works on auto-selected row and clears stale decision footer on switch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleApprovals(page, "light", "ko", { staleOnFirst: true, staleToNone: true });
  try {
    await page.goto("/approvals");
    const sidePane = page.locator('aside[data-pane="record"]');
    await expect(sidePane).toBeVisible();

    const fullBtn = sidePane.getByRole("button", { name: t("uiFlexibleColumns.full"), exact: true });
    await expect(fullBtn).toHaveAttribute("aria-pressed", "false");
    await fullBtn.click();
    await expect(fullBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(new RegExp(`sel=${saeonUniverse.approval.documentNumber}&full=1`));
    await fullBtn.click();
    await expect(fullBtn).toHaveAttribute("aria-pressed", "false");

    // Start decision on doc 1 (409 sets decisionDocId and refetches doc 1 with my_actions=none), switch to doc 2, switch back -> no empty footer
    await sidePane.getByRole("button", { name: t("composer.verb.approve"), exact: true }).click();
    await expect(sidePane.getByRole("alert")).toContainText(t("approvals.viewer.changed"));

    const table = page.getByRole("grid", { name: t("approvals.list"), exact: true });
    await table.locator('tbody tr[data-id="AP-2026-0419"]').click();
    await expect(sidePane).toContainText("AP-2026-0419");

    await table.locator(`tbody tr[data-id="${saeonUniverse.approval.documentNumber}"]`).click();
    await expect(sidePane).toContainText(saeonUniverse.approval.documentNumber);
    await expect(sidePane.locator("> div")).toHaveCount(1);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
