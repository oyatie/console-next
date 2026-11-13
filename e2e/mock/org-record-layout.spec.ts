// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { AT, authz, id, user } from "./fixtures";
import { orgChange } from "./org-changes";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { orgChangeScreens } from "../states/registry";
import type { components } from "@console/api/schema";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`org summary keeps its content and desktop position after rejection at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    const screen = orgChangeScreens[1];
    const fixture = await mockScreen(page, screen, "approval");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
      { feature: "org_change_approve", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false },
    ] } });
    let record: components["schemas"]["OrgChangeDetail"] = { ...orgChange("approval"), draftedBy: id(5), events: [
      { at: AT, actor: id(5), actorName: "김기안", action: "create" },
      { at: AT, actor: id(5), actorName: "김기안", action: "draft.update" },
      { at: AT, actor: id(5), actorName: "김기안", action: "submit" },
    ] };
    await mockRoute(page, "get", "/api/v1/org-changes/{id}", () => ({ status: 200, json: record }));
    await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", () => {
      record = { ...record, status: "REJECTED", approvalSteps: record.approvalSteps.map(step => ({ ...step, decision: "REJECTED", decidedBy: user.id, decidedAt: AT, memo: "시행일 재검토" })),
        events: [...record.events, { at: AT, actor: user.id, actorName: user.display_name, action: "step.decide", reason: "hr:REJECTED" }],
      };
      return { status: 200, json: record };
    });
    try {
      await page.goto(screen.path);
      const proposal = page.getByRole("region", { name: t("orgChange.proposal"), exact: true });
      const reject = page.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: "reject" }), exact: true });
      await expect(reject).toBeEnabled();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(proposal).toContainText(record.reason);
      const history = page.getByRole("complementary", { name: t("orgChange.history"), exact: true });
      const rows = history.getByRole("listitem");
      await expect(rows).toHaveCount(record.events.length);
      const rowPositions = () => rows.evaluateAll(elements => {
        const main = document.getElementById("main")!;
        const history = document.getElementById("history")!.parentElement!.getBoundingClientRect();
        return elements.map(el => ({ text: el.textContent, y: el.getBoundingClientRect().top + main.scrollTop,
          historyY: el.getBoundingClientRect().top - history.top }));
      });
      const existingRows = await rowPositions();
      const position = () => page.evaluate(desktop => {
        const main = document.getElementById("main")!;
        const proposal = document.getElementById("proposal")!.parentElement!.getBoundingClientRect();
        const history = document.getElementById("history")!.parentElement!.getBoundingClientRect();
        return [proposal.height, ...(desktop ? [proposal.top + main.scrollTop, history.top + main.scrollTop] : [])];
      }, width === 1440);
      const before = await position();
      await reject.click();
      await page.getByLabel(t("orgChange.decide.reject.reason")).fill("시행일 재검토");
      await reject.click();
      await expect(page.getByRole("status").filter({ hasText: t("orgChange.decided.REJECTED", { role: "인사", code: record.code }) })).toBeVisible();
      await expect(proposal).toContainText(record.reason);
      expect(await position()).toEqual(before);
      await expect(rows).toHaveCount(existingRows.length + 1);
      // On phones the main column can grow; the history rows keep their positions within the history card.
      expect((await rowPositions()).filter(row => existingRows.some(existing => existing.text === row.text)).map(row => ({ text: row.text, y: width === 1440 ? row.y : row.historyY })))
        .toEqual(existingRows.map(row => ({ text: row.text, y: width === 1440 ? row.y : row.historyY })));
      await fits(page, "org rejection");
      await page.screenshot({ path: test.info().outputPath("rejected.png") });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) {
  test(`org summary keeps its height after submission at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = orgChangeScreens[1];
    const fixture = await mockScreen(page, screen, "draft");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
      { feature: "org_change_draft", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false },
    ] } });
    let record = { ...orgChange("draft"), headcount: 0 };
    await mockRoute(page, "get", "/api/v1/org-changes/{id}", () => ({ status: 200, json: record }));
    await mockRoute(page, "post", "/api/v1/org-changes/{id}/submit", () => {
      record = { ...record, headcount: record.preflight!.headcount, status: "IN_APPROVAL", approvalSteps: orgChange("approval").approvalSteps };
      return { status: 200, json: record };
    });
    try {
      await page.goto(screen.path);
      const proposal = page.getByRole("region", { name: t("orgChange.proposal"), exact: true });
      const submit = page.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: "apply" }), exact: true });
      await expect(submit).toBeEnabled();
      await expect(proposal).toContainText(t("orgChange.headcount.value", { count: record.preflight!.headcount }));
      const before = (await proposal.boundingBox())!.height;
      await submit.click();
      await expect(page.locator("#change-receipt")).toBeFocused();
      expect((await proposal.boundingBox())!.height).toBe(before);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
