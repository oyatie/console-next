// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import type { components } from "@console/api";
import { t } from "@console/i18n";
import { test } from "../locale-fixture";
import { AT, id } from "./fixtures";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { saeonAdminUser } from "./saeon";

for (const experience of ["baseline", "console"] as const) {
  test(`a named handler answers a change request with a note in ${experience}`, async ({ page }) => {
    const fixture = await setupConsoleSaeonPeople(page, { experience, canManage: false });
    const handler = saeonAdminUser().id;
    const row: components["schemas"]["ChangeRequest"] = {
      id: id(313), kind: "ACCESS_EXPLANATION", subject_type: "USER_ACCOUNT", subject_id: handler,
      requested_by: id(411), assignee_user_id: handler, assignee_role: "HR", status: "OPEN",
      can_review: true, payload: {}, reason_code: "OTHER", review_required: false, created_at: AT,
    };
    let decided = false;
    const calls: unknown[] = [];
    await mockRoute(page, "get", "/api/v1/change-requests", req => {
      const params = new URL(req.url()).searchParams;
      const items = !decided && (params.get("assignee") === "me" || params.get("id") === row.id) ? [row] : [];
      return { status: 200, json: { items, total: items.length, offset: 0, limit: 20 } };
    });
    await mockRoute(page, "post", "/api/v1/change-requests/{id}/decide", req => {
      calls.push(req.postDataJSON());
      decided = true;
      return { status: 200, json: { ...row, status: "APPLIED", can_review: false } };
    });
    try {
      await page.goto(`/people/requests?sel=${row.id}`);
      await expect(page.getByRole("button", { name: t("requests.decide.APPLY"), exact: true })).toBeVisible();
      await page.goto("/people/requests?lane=me");
      await page.getByRole("button", { name: t("requests.open"), exact: true }).click();
      await page.getByRole("button", { name: t("requests.decide.APPLY"), exact: true }).click();
      await page.getByRole("textbox", { name: t("requests.decision.reason") }).fill("REVIEWED");
      const submit = page.getByRole("button", { name: t("requests.commit.APPLY"), exact: true });
      await submit.click();
      await expect(page.getByText(t("requests.answer.missing"), { exact: true })).toBeVisible();
      expect(calls).toEqual([]);
      await page.getByRole("textbox", { name: t("requests.answer") }).fill("Synthetic access review response");
      await submit.click();
      await expect(page.getByText(t("requests.done.APPLIED", { kind: t("requests.kind.ACCESS_EXPLANATION") }))).toBeVisible();
      expect(calls).toEqual([{ decision: "APPLY", reason_code: "REVIEWED", note: "Synthetic access review response" }]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`another HR holder reads a policy question without controls reserved for its named handler in ${experience}`, async ({ page }) => {
    const fixture = await setupConsoleSaeonPeople(page, { experience });
    const row: components["schemas"]["ChangeRequest"] = {
      id: id(314), kind: "POLICY_QUESTION", subject_type: "ORGANIZATION", subject_id: id(400),
      requested_by: id(411), assignee_user_id: id(412), assignee_role: "HR", status: "OPEN",
      can_review: false, payload: {}, reason_code: "OTHER", review_required: false, created_at: AT,
    };
    await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [row], total: 1, offset: 0, limit: 20 } });
    await mockRoute(page, "get", "/api/v1/change-requests/counts", { status: 200, json: { all: 1, me: 0, role: 0 } });
    try {
      await page.goto(`/people/requests?sel=${row.id}`);
      await expect(page.getByRole("button", { name: t("requests.panel.close"), exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: t("requests.decide.APPLY"), exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: t("requests.decide.DECLINE"), exact: true })).toHaveCount(0);
    } finally { await page.close(); fixture.release(); }
  });
}
