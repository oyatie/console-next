// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { experienceState } from "../experience";
import { test } from "../locale-fixture";
import { screens } from "../states/registry";
import { accountReads } from "./account";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { saeonHeroToken, saeonHeroUser } from "./saeon";
import { mockScreen } from "./screen";

for (const experience of ["baseline", "console"] as const) test.describe(experience, () => {
  test.use({ storageState: experienceState(experience) });
  test("Desk shows all open filings and distinguishes them from requests assigned to the same HR user", async ({ page }) => {
    await mockScreen(page, screens[0], "empty");
    await accountReads(page, "save-unchanged");
    const user = saeonHeroUser();
    await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonHeroToken() });
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: user });
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, user_id: user.id,
      capabilities: [{ feature: "employee_directory_manage", permission: "allow", org_wide: true, scoped: false, branch_scope: { kind: "all" } }] } });
    const filed = Array.from({ length: 7 }, (_, i): components["schemas"]["ChangeRequest"] => ({
      id: id(300 + i), kind: "OTHER", subject_type: "EMPLOYEE", subject_id: id(400 + i), subject_name: "Filed " + (i + 1),
      payload: {}, reason_code: "OTHER", requested_by: user.id, assignee_role: "HR", assignee_user_id: id(99),
      status: "OPEN", review_required: false, created_at: AT,
    }));
    const assigned = { ...filed[0]!, id: id(310), requested_by: id(99), assignee_user_id: user.id, subject_name: "Assigned case" };
    let outcome: "loaded" | "failed" | "empty" = "loaded";
    await mockRoute(page, "get", "/api/v1/change-requests", request => {
      const q = new URL(request.url()).searchParams;
      expect(q.get("status")).toBe("OPEN");
      if (outcome === "failed") return { status: 503, json: failure("service_unavailable") };
      const limit = Number(q.get("limit"));
      const rows = outcome === "empty" ? [] : [...filed, assigned].filter(r =>
        (q.get("requester") !== "me" || r.requested_by === user.id) && (q.get("assignee") !== "me" || r.assignee_user_id === user.id));
      return { status: 200, json: { items: rows.slice(0, limit), total: rows.length, limit, offset: 0 } };
    });
    const desk = "/me/desk?view=requests";
    await page.goto(desk);
    const stat = page.locator("dt").filter({ hasText: t("me.desk.stat.requests") }).locator("..").locator("dd");
    await expect(stat).toHaveText(t("me.desk.stat.requestsValue", { count: 7 }));
    await page.getByRole("link", { name: t("me.desk.links.requests"), exact: true }).click();
    await expect(page).toHaveURL(/lane=filed/);
    await expect(page.getByText("Filed 7 (—)", { exact: true })).toBeVisible();
    await expect(page.getByText("Assigned case (—)", { exact: true })).toHaveCount(0);
    await page.getByRole(experience === "console" ? "link" : "button", { name: t("requests.lane.me") }).click();
    await expect(page.getByText("Assigned case (—)", { exact: true })).toBeVisible();
    await expect(page.getByText("Filed 7 (—)", { exact: true })).toHaveCount(0);
    outcome = "failed";
    await page.goto(desk);
    await expect(stat).toHaveText(t("me.desk.stat.requestsUnavailable"));
    outcome = "empty";
    await page.reload();
    await expect(stat).toHaveText(t("me.desk.stat.requestsValue", { count: 0 }));
  });
});
