// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { AT, id, user } from "./fixtures";
import { setupPlatformMocks } from "./platform-console-fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

test("an approvals-enabled tenant can read its inbox when the build omits workflow submission", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "get", "/api/v1/onboarding/modules", {
    status: 200, json: [{ key: "approvals", ready: true, unblock: null }],
  });
  let reads = 0;
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/v1/workflow-studio/submittable-definitions") reads++; });
  try {
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: t("approvals.title"), level: 1 })).toBeVisible();
    await expect(page.locator('a[href="/approvals/new"]')).toHaveCount(0);
    await page.goto("/approvals/new");
    await expect(page.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    expect(reads).toBe(0);
  } finally {
    await page.close();
    fixture.release();
  }
});

for (const width of [1440, 390] as const) {
  test(`Wave 6 /approvals/new starts workflow run with optional approval-line override at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(([key]) => localStorage.setItem(key!, "console"), [EXPERIENCE_KEY]);
    const fixture = await mockScreen(page, screens[0], "populated");
    await mockRoute(page, "get", "/api/v1/users/me", {
      status: 200,
      json: { ...user, employee_link_status: "LINKED", employee_id: id(1) },
    });
    await mockRoute(page, "get", "/api/v1/onboarding/modules", {
      status: 200, json: [{ key: "approvals", ready: true, unblock: null }, { key: "approval_submission", ready: true, unblock: null }],
    });
    await mockRoute(page, "get", "/api/v1/workflow-studio/submittable-definitions", {
      status: 200,
      json: {
        reviewer_role_keys: ["executive", "hr_reviewer"],
        items: [
          {
            id: id(401),
            workflow_key: "general_expense",
            display_name: "General Approval",
            object_type: "general_request",
            active_version: 2,
            required_approval_line: true,
            required_payment_line: false,
            allow_approval_line_override: true,
          },
        ],
      },
    });
    const starts: unknown[] = [];
    await mockRoute(page, "post", "/api/v1/workflow-runs", (req) => {
      starts.push(req.postDataJSON());
      return {
        status: 200,
        json: {
          run: {
            id: id(450),
            definition_id: id(401),
            definition_version: 2,
            status: "RUNNING",
            trigger_type: "MANUAL",
            started_at: AT,
            created_at: AT,
            updated_at: AT,
          },
        },
      };
    });

    try {
      await page.goto("/approvals/new");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: t("approvals.new.title"), level: 1 })).toBeVisible();
      if (width === 1440) {
        await expect(page.getByRole("banner").getByRole("link", { name: t("shell.link.meDesk") })).toBeVisible();
      }
      await main.getByLabel(new RegExp(t("approvals.new.subject"))).fill("Equipment purchase request");
      await main.getByLabel(new RegExp(t("approvals.new.reason"))).fill("Replace worn inspection gauge");
      await main.getByRole("button", { name: t("approvals.new.addStep"), exact: true }).click();
      await main.getByRole("button", { name: new RegExp(t("approvals.new.stepRole")) }).click();
      await page.getByRole("option", { name: "executive", exact: true }).click();

      for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(page, `/approvals/new/${width}/${theme}`);
      }
      await expectAxe(page, `/approvals/new/${width}`);

      await main.getByRole("button", { name: t("approvals.new.submit"), exact: true }).click();
      await expect(main).toContainText(id(450));
      await expect(main.getByRole("button", { name: t("approvals.new.submit"), exact: true })).toHaveCount(0);
      await expect(main.getByLabel(new RegExp(t("approvals.new.subject")))).toHaveCount(0);
      await expect(main.getByRole("link", { name: t("approvals.new.viewRequested") })).toHaveAttribute("href", /approvals.*requested/);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        definition_id: id(401),
        trigger_type: "MANUAL",
        approval_line_overrides: [{ assignee_role_key: "executive" }],
      });
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });

  test(`Wave 6 /account/location transitions consent state cleanly at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(([key]) => localStorage.setItem(key!, "console"), [EXPERIENCE_KEY]);
    const fixture = await mockScreen(page, screens[0], "populated");
    let state: "NO_RECORD" | "GRANTED" | "SUSPENDED" | "WITHDRAWN" = "NO_RECORD";
    const statusJson = () => ({
      consent_id: id(501),
      user_id: user.id,
      branch_id: id(4),
      state,
      may_collect: state === "GRANTED",
      granted_at: state === "NO_RECORD" ? null : AT,
      suspended_at: state === "SUSPENDED" ? AT : null,
      resumed_at: null,
      withdrawn_at: state === "WITHDRAWN" ? AT : null,
      updated_at: AT,
    });
    await mockRoute(page, "get", "/api/v1/location-consent/status", () => ({ status: 200, json: statusJson() }));
    await mockRoute(page, "post", "/api/v1/location-consent/grant", () => { state = "GRANTED"; return { status: 200, json: statusJson() }; });
    await mockRoute(page, "post", "/api/v1/location-consent/suspend", () => { state = "SUSPENDED"; return { status: 200, json: statusJson() }; });
    await mockRoute(page, "post", "/api/v1/location-consent/resume", () => { state = "GRANTED"; return { status: 200, json: statusJson() }; });
    await mockRoute(page, "post", "/api/v1/location-consent/withdraw", () => { state = "WITHDRAWN"; return { status: 200, json: statusJson() }; });

    try {
      await page.goto("/account/location");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: t("account.location.title"), level: 1 })).toBeVisible();
      await expect(main).toContainText(t("account.location.state.NO_RECORD"));

      for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(page, `/account/location/${width}/${theme}`);
      }
      await expectAxe(page, `/account/location/${width}`);

      await main.getByRole("button", { name: t("account.location.grant"), exact: true }).click();
      await expect(main).toContainText(t("account.location.state.GRANTED"));
      await main.getByRole("button", { name: t("account.location.suspend"), exact: true }).click();
      await expect(main).toContainText(t("account.location.state.SUSPENDED"));
      await main.getByRole("button", { name: t("account.location.resume"), exact: true }).click();
      await expect(main).toContainText(t("account.location.state.GRANTED"));
      await main.getByRole("button", { name: t("account.location.withdraw"), exact: true }).click();
      await expect(main).toContainText(t("account.location.state.WITHDRAWN"));
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });

  test(`Wave 6 /me/dispatch-offers lists and responds to P1 offers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(([key]) => localStorage.setItem(key!, "console"), [EXPERIENCE_KEY]);
    const fixture = await mockScreen(page, screens[0], "populated");
    let offers = [
      {
        dispatch_id: id(601),
        work_order_id: id(602),
        branch_id: id(4),
        request_no: "WO-2026-0601",
        site_name: "North service bay",
        symptom: "Lift reports a pressure fault",
        accept_window_started_at: AT,
        accept_window_ends_at: "2026-12-01T09:15:00Z",
      },
    ];
    const other = { ...offers[0]!, dispatch_id: id(603), request_no: "WO-2026-0603" };
    offers.unshift(other);
    await mockRoute(page, "get", "/api/v1/me/dispatch-offers", () => ({ status: 200, json: { items: offers } }));
    await mockRoute(page, "post", "/api/v1/p1-dispatches/{dispatchId}/responses", request => {
      expect(new URL(request.url()).pathname).toContain(id(601));
      offers = [other];
      return {
        status: 200 as const,
        json: {
          id: id(601),
          work_order_id: id(602),
          branch_id: id(4),
          status: "AUTO_ASSIGNED" as const,
          accept_window_started_at: AT,
          accept_window_ends_at: "2026-12-01T09:15:00Z",
          auto_assigned_mechanic_id: id(1),
          manual_call_required: false,
          target_count: 1,
          accepted_count: 1,
          declined_count: 0,
        },
      };
    });

    try {
      await page.goto("/me/dispatch-offers");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: t("me.dispatch.title"), level: 1 })).toBeVisible();
      await expect(main.getByText("WO-2026-0601").first()).toBeVisible();

      for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(page, `/me/dispatch-offers/${width}/${theme}`);
      }
      await expectAxe(page, `/me/dispatch-offers/${width}`);
      await main.locator(`[data-id="${id(601)}"]`).click();
      await expect(page).toHaveURL(new RegExp(`sel=${id(601)}`));
      await page.reload();
      await expect(main.getByText("North service bay", { exact: true })).toBeVisible();
      await expect(main.getByText("Lift reports a pressure fault", { exact: true })).toBeVisible();
      await main.getByRole("button", { name: t("me.dispatch.accept"), exact: true }).click();
      await expect(page).not.toHaveURL(/sel=/);
      await page.goto(`/me/dispatch-offers?sel=${id(601)}`);
      await expect(main.getByText(t("me.dispatch.unavailable"), { exact: true })).toBeVisible();
      await expect(main.getByRole("button", { name: t("me.dispatch.accept"), exact: true })).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

test("Wave 6 /requests renders personal request history and /platform sends & cancels 7-day group invite", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupPlatformMocks(page);
  try {
    await page.goto("/platform");
    const main = page.getByRole("main");
    await main.getByRole("navigation", { name: t("tenants.tabs") }).getByRole("link", { name: t("tenants.tab.groups"), exact: true }).click();
    await main.getByRole("button", { name: t("tenants.groups.inviteOrg"), exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: t("tenants.groups.inviteSubmit"), exact: true }).click();
    await expect(main.getByText(t("tenants.groups.pendingInvites"))).toBeVisible();
    await main.getByRole("button", { name: t("tenants.groups.cancelInvite"), exact: true }).click();
    await expect(main.getByText(t("tenants.groups.pendingInvites"))).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});
