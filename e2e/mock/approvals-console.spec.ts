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
} from "./saeon";
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
    refuseDecision?: boolean;
    docOverrides?: Partial<ReturnType<typeof saeonApprovalDocument>>;
  } = {},
) {
  await enableConsoleExperience(page, theme, locale);
  const fixture = await mockScreen(page, screens[0], "empty");
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });

  let currentDoc = { ...saeonApprovalDocument(saeonUniverse.approval.documentNumber), ...options.docOverrides };
  let decisionAttempts = 0;

  await mockRoute(page, "get", "/api/v1/approvals", request => {
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

  await mockRoute(page, "get", "/api/v1/approvals/{id}", request => {
    const docId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
    if (docId === saeonUniverse.approval.documentNumber) {
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
  await mockRoute(page, "post", "/api/v1/approvals/{id}/decision", request => {
    const body = request.postDataJSON() as { decision: "APPROVE" | "REJECT" | "RETURN" };
    decisions.push({ body, key: request.headers()["idempotency-key"] ?? null });
    decisionAttempts++;
    if (options.refuseDecision) {
      return { status: 403, json: failure("forbidden") };
    }
    if (options.staleOnFirst && decisionAttempts === 1) {
      currentDoc = {
        ...currentDoc,
        revision: 2,
        fingerprint: "sha256:saeon-oc-2026-0418-r2",
        summary: `${saeonUniverse.approval.reason} (v2)`,
      };
      return { status: 409, json: failure("approval_document_changed") };
    }
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

  return { fixture, decisions };
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

        if (width === 390) {
          const rowHeights = await table.locator("tbody tr[data-id]").evaluateAll(rows =>
            rows.map(r => {
              const rect = r.getBoundingClientRect();
              return { height: Math.round(rect.height), bottom: Math.round(rect.bottom) };
            }),
          );
          expect(rowHeights.every(r => r.height >= 48 && r.height <= 68)).toBe(true);
          expect(rowHeights.filter(r => r.bottom <= 900).length).toBeGreaterThanOrEqual(6);
        }

        await withFullPage(page, () => shot(page, `approvals--${width}-${theme}`));
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
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });

    test(`Console /approvals/$approvalId renders P4 DocumentDecision at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupConsoleApprovals(page, theme);
      try {
        await page.goto(`/approvals/${saeonUniverse.approval.documentNumber}`);
        const pattern = page.locator('[data-pattern="document-decision"]');
        await expect(pattern).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("approvals.console.title"), exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: saeonUniverse.approval.title, exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: t("approvals.preview.facts"), exact: true })).toContainText(saeonUniverse.approval.documentNumber);
        await expect(page.getByRole("region", { name: t("approvals.preview.route"), exact: true })).toContainText(saeonUniverse.approval.steps[1]!.actor);

        const proposalSection = page.getByRole("region", { name: t("approvals.field.proposal"), exact: true });
        await expect(proposalSection).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.departments[2]!.split(" › ").at(-1)!);
        await expect(proposalSection).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.departments[3]!.split(" › ").at(-1)!);

        const aside = pattern.locator("aside");
        await expect(aside).toBeVisible();
        const cardBorder = await aside.locator("article").evaluate(el => getComputedStyle(el).borderStyle);
        expect(cardBorder).toBe("none");

        await withFullPage(page, () => shot(page, `approval--${width}-${theme}`));
        await fits(page, `Console /approvals/$approvalId ${width} ${theme}`);
        await expectAxe(page, `Console /approvals/$approvalId ${width} ${theme}`);

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
      const article = page.getByRole("article", { name: t("approvals.viewer.decision"), exact: true });
      const heading = article.getByRole("heading", { level: 2, name: t("approvals.viewer.decision"), exact: true });
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
      await expect(page.getByText(t("approvals.viewer.revision", { revision: 2 }), { exact: true })).toBeVisible();
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
