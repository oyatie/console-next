// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { test } from "../locale-fixture";
import { experienceState } from "../experience";
import { homeSetupChecklist, homeSetupScreen } from "../states/home-setup";
import { AT, id, inbox, screenAccess, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));
for (const experience of ["baseline", "console"] as const) test.describe(experience, () => {
  test.use({ storageState: experienceState(experience) });

  test("scoped approver opens the setup confirmation and the viewer sees its receipt @ui-state", async ({ page }) => {
    await mockScreen(page, homeSetupScreen, "empty");
    const scope = id(33);
    const items: components["schemas"]["OvertimeRuleAttestation"][] = [];
    let canRecord = true;
    const setup = homeSetupChecklist("first");
    setup.steps = [{ ...setup.steps[0]!, key: "overtime", needs: "attendance::approve",
      action: "confirm_overtime_rule", can_act: true, skippable: false }];
    setup.total = 1;
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", () => ({ status: 200, json: setup }));
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: { ...inbox(0), setup } }));
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { name: "Assembly test", phase: "SETUP", go_live_at: null } } });
    await mockRoute(page, "get", "/api/v1/access/me", () => ({ status: 200, json: { ...screenAccess("/", "SETUP"),
      entries: (canRecord ? ["view", "approve"] as const : ["view"] as const).map<components["schemas"]["AccessEffectiveEntry"]>(level => ({ level, domain: "attendance",
        enforcement: "ENFORCED", role_name_ko: "Attendance", role_id: id(34), grant_id: id(35), valid_from: AT, caveats: [],
        scope: { kind: "LEGAL_ENTITY", node_id: scope, node_name: "Assembly", include_descendants: true } })) } }));
    const path = "/api/v1/settings/overtime-attestations";
    await mockRoute(page, "get", path, request => {
      expect(new URL(request.url()).searchParams.get("scope_entity_id")).toBe(scope);
      return { status: 200, json: { items, can_record: canRecord } };
    });
    await mockRoute(page, "post", path, request => {
      const body = request.postDataJSON();
      expect(body).toEqual({ scope_entity_id: scope, confirmed_on: "2026-09-21", rule_reference: "Article 7", worker_notice_method: "Written notice" });
      const record = { ...body, id: id(36), recorded_by: user.id, recorded_by_name: user.display_name, statutory_basis: "Synthetic fixture", created_at: AT };
      items.push(record);
      setup.steps[0] = { ...setup.steps[0]!, state: "done" };
      setup.done = 1;
      return { status: 201, json: record };
    });

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-experience", experience);
    await expect(page.getByRole("button", { name: t("setup.skip.overtime") })).toHaveCount(0);
    await page.getByRole("link", { name: t("setup.fix.confirm_overtime_rule"), exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/overtime$/);
    await expect(page.getByRole("heading", { name: "Assembly" })).toBeVisible();
    await page.getByLabel(t("settingsHub.attestation.confirmedOn")).fill("2026-09-21");
    await page.getByLabel(t("settingsHub.attestation.ruleReference")).fill("Article 7");
    await page.getByLabel(t("settingsHub.attestation.noticeMethod")).fill("Written notice");
    const record = page.getByRole("button", { name: t("settingsHub.attestation.recordAction") });
    await record.click();
    await expect(page.getByText("Article 7", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.locator("[data-step-state]")).toHaveText(t("uiSetupRail.state.done"));
    canRecord = false;
    await page.goto("/settings");
    await page.getByRole("link", { name: t("setup.step.overtime"), exact: true }).click();
    await expect(page.getByText("Article 7", { exact: true })).toBeVisible();
    await expect(record).toHaveCount(0);
  });

  test("tenant-wide operator explicitly skips the optional confirmation @ui-state", async ({ page }) => {
    await mockScreen(page, homeSetupScreen, "empty");
    const setup = homeSetupChecklist("first");
    setup.steps = [{ ...setup.steps[0]!, key: "overtime", needs: "attendance::approve",
      action: "confirm_overtime_rule", can_act: true, skippable: true }];
    setup.total = 1;
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/", "SETUP"), is_ops: true } });
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true, tenant: { name: "Assembly test", phase: "SETUP", go_live_at: null } } });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", () => ({ status: 200, json: setup }));
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: { ...inbox(0), setup } }));
    await mockRoute(page, "post", "/api/v1/onboarding/steps/{step}/skip", request => {
      expect(new URL(request.url()).pathname).toBe("/api/v1/onboarding/steps/overtime/skip");
      setup.steps[0] = { ...setup.steps[0]!, state: "done", skippable: false };
      setup.done = 1;
      return { status: 204 };
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-experience", experience);
    const skip = page.getByRole("button", { name: t("setup.skip.overtime") });
    await skip.click();
    await expect(page.locator("[data-step-state]")).toHaveText(t("uiSetupRail.state.done"));
    await expect(skip).toHaveCount(0);
  });
});
