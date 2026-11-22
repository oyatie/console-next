// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { failure, id } from "./fixtures";
import { mockRoute } from "./route";
import {
  applyThemeAndCheck,
  makeOperators,
  makeOrgs,
  ME_ID,
  OPERATOR_NAME,
  PEER_ID,
  setupPlatformMocks,
  SUP_1,
  SUP_2,
  SUP_3,
  THIRD_ID,
} from "./platform-console-fixtures";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390] as const) {
  test(`platform console tabs render cleanly, auto-select on desktop, pass fits+axe, and capture ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { fixture } = await setupPlatformMocks(page);
    await page.goto("/platform");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: t("tenants.title"), level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(main.getByText("Saeon Precision Co.").first()).toBeVisible();
    if (width === 1440) {
      await expect(page.getByRole("banner")).toContainText(OPERATOR_NAME);
      await expect(main.locator('[data-pane="record"]').getByRole("heading", { level: 2 })).toContainText("Harbor Cloud Inc.");
      await expect(main.getByRole("heading", { name: t("tenants.panel.overview") })).toBeVisible();
      await expect(main.getByRole("heading", { name: t("opsRecovery.title") })).toBeVisible();
    }
    await applyThemeAndCheck(page, "platform-tenants", width);

    const nav = main.getByRole("navigation", { name: t("tenants.tabs") });
    for (const [tabKey, titleKey, marker, recordTitle, paneHeading] of [
      ["tenants.tab.groups", "tenants.groups.title", "Saeon Industrial Group", "Saeon Industrial Group", "tenants.groups.members"],
      ["tenants.tab.operators", "tenants.operators.title", "Jiwon Seo (Primary)", "Jiwon Seo (Primary)", "tenants.operators.details"],
      ["tenants.tab.support", "tenants.support.title", "Saeon Precision Co.", "40100000", "tenants.support.details"],
    ] as const) {
      await nav.getByRole("link", { name: t(tabKey), exact: true }).click();
      await expect(main.getByRole("heading", { name: t(titleKey), level: 1 })).toBeVisible();
      await expect(main.getByText(marker).first()).toBeVisible();
      if (width === 1440) {
        await expect(main.locator('[data-pane="record"]').getByRole("heading", { level: 2 })).toContainText(recordTitle);
        await expect(main.getByRole("heading", { name: t(paneHeading) })).toBeVisible();
      }
      const slug = tabKey.split(".").pop()!;
      await applyThemeAndCheck(page, `platform-${slug}`, width);
    }

    if (width === 1440) {
      await main.getByRole("button", { name: t("common.closePanel") }).click();
      await expect(main.getByRole("heading", { name: t("tenants.support.details") })).toHaveCount(0);
      await main.locator("[data-id]").first().click();
      await expect(main.getByRole("heading", { name: t("tenants.support.details") })).toBeVisible();
    }
    expect(fixture.unexpected).toEqual([]);
  });
}

test("Console /platform empty state renders one primary CTA without unrequested groups query", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupPlatformMocks(page, { emptyOrgs: true });
  await page.goto("/platform");
  const main = page.getByRole("main");
  await expect(main.getByText(t("tenants.empty.title"))).toBeVisible({ timeout: 15_000 });
  await expect(main.getByRole("button", { name: t("tenants.create"), exact: true })).toHaveCount(1);
  expect(fixture.unexpected).toEqual([]);
});

test("Tenants tab: filters, view URL sync, SupportLookup, Admin OTP reissue, OpsRecovery SoD & Erase refusal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupPlatformMocks(page, {
    eraseOverride: (orgId) => orgId === id(104)
      ? { archived: true, legal_hold: false, second_operator_available: true, cooling_hours: 72, request: { id: id(601), target_org_id: id(104), requested_by: PEER_ID, opened_at: AT_REF, approved_by: null, cooling_until: null, cancelled_at: null, erased_at: null } }
      : { archived: false, legal_hold: false, second_operator_available: true, cooling_hours: 72, request: null },
    recoveryOverride: (orgId) => orgId === id(101)
      ? { state: "WAITING_APPROVAL", recovery_available: true, ops_has_passkey: true, ops_enrolled: true, second_operator_available: true, active_accounts: 2, hold_hours: 24, code_ttl_minutes: 15, request: { id: id(501), target_user_id: id(10), requested_by: PEER_ID, requested_by_name: "Minho Kang", opened_at: AT_REF, approved_by: null, hold_until: null, cancelled_by: null, cancelled_at: null, cancelled_by_name: null, cancel_reason: null, issued_at: null, authoriser_role: "REPRESENTATIVE", authoriser_name: "CEO Kim", proofing_method: "video", evidence_ref: "EV-991" } }
      : { state: null, recovery_available: true, ops_has_passkey: true, ops_enrolled: orgId !== id(102), second_operator_available: true, active_accounts: 2, hold_hours: 24, code_ttl_minutes: 15, request: null },
  });
  await mockRoute(page, "post", "/api/platform/orgs/{id}/ops-recovery/{rid}/approve", { status: 403, json: failure("ops_recovery_sod_requester") });
  await mockRoute(page, "post", "/api/platform/orgs/{id}/erase/{rid}/approve", { status: 403, json: failure("erase_same_operator") });

  await page.goto(`/platform?view=suspended&sel=${id(103)}`);
  const main = page.getByRole("main");
  await expect(main.getByText("Northstar Bio Labs").first()).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText("Saeon Precision Co.")).toHaveCount(0);
  await main.getByRole("button", { name: t("tenants.view.all"), exact: true }).click();
  await expect(page).toHaveURL(/sel=/);
  await expect(page).not.toHaveURL(/view=suspended/);
  const nav = main.getByRole("navigation", { name: t("tenants.tabs") });
  await nav.getByRole("link", { name: t("tenants.tab.operators"), exact: true }).click();
  await nav.getByRole("link", { name: t("tenants.tab.tenants"), exact: true }).click();
  await expect(main.getByText("Saeon Precision Co.").first()).toBeVisible();
  await expect(main.getByRole("heading", { name: "Northstar Bio Labs" }).first()).toBeVisible();

  await page.goto(`/platform?view=archived&sel=${id(104)}`);
  await expect(main.getByText("BluePeak Retail").first()).toBeVisible({ timeout: 15_000 });
  await main.getByRole("button", { name: t("tenants.rail.reset") }).click();
  await expect(page).not.toHaveURL(/view=archived/);
  await expect(main.getByText("Saeon Precision Co.").first()).toBeVisible();

  await main.getByRole("button", { name: t("tenants.supportLookup.title") }).click();
  const lookupDialog = page.getByRole("dialog");
  await lookupDialog.locator("summary").click();
  await lookupDialog.getByRole("textbox").fill("sup-401");
  await lookupDialog.getByRole("button", { name: t("tenants.supportLookup.action") }).click();
  await expect(lookupDialog.getByText("trace-sup-401")).toBeVisible();
  await lookupDialog.getByRole("button", { name: t("tenants.code.close") }).first().click();

  await main.locator(`[data-id="${id(102)}"]`).click();
  await main.getByRole("button", { name: t("tenants.reissue") }).click();
  await expect(page.getByRole("dialog").getByText("REISSUE999", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.code.close") }).first().click();

  await main.locator(`[data-id="${id(101)}"]`).click();
  await expect(main.getByRole("button", { name: t("tenants.reissue") })).toBeDisabled();
  await main.getByRole("button", { name: t("opsRecovery.approve") }).click();
  await expect(main.getByRole("alert")).toContainText(t("opsRecovery.refusal.ops_recovery_sod_requester"));

  await main.locator(`[data-id="${id(104)}"]`).click();
  await main.getByRole("button", { name: t("tenants.erase.approve") }).click();
  await expect(main.getByRole("alert")).toContainText(t("tenants.erase.erase_same_operator"));

  await main.locator(`[data-id="${id(101)}"]`).click();
  await main.getByRole("button", { name: t("tenants.panel.supportOpen") }).first().click();
  await expect(main.getByRole("heading", { name: t("tenants.support.title"), level: 1 })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

const AT_REF = "2026-10-27T09:00:00Z";

test("Groups tab: create group, edit reset on cancel, assign org, group account OTP, revoke role", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, stepUps } = await setupPlatformMocks(page);
  await page.goto("/platform");
  const main = page.getByRole("main");
  await main.getByRole("navigation", { name: t("tenants.tabs") }).getByRole("link", { name: t("tenants.tab.groups"), exact: true }).click();

  await main.getByRole("button", { name: t("tenants.groups.create") }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel(t("tenants.groups.form.name")).fill("Pacific Partners");
  await createDialog.getByLabel(t("tenants.groups.form.slug")).fill("pacific-partners");
  await createDialog.getByRole("button", { name: t("tenants.groups.form.submitCreate") }).click();
  await expect(main.getByText("Pacific Partners").first()).toBeVisible();

  await main.locator(`[data-id="${id(201)}"]`).click();
  await main.getByRole("button", { name: t("tenants.groups.edit") }).click();
  await page.getByRole("dialog").getByLabel(t("tenants.groups.form.name")).fill("Dirty Group Edit");
  await page.getByRole("dialog").getByRole("button", { name: t("common.cancel") }).click();
  await main.getByRole("button", { name: t("tenants.groups.edit") }).click();
  await expect(page.getByRole("dialog").getByLabel(t("tenants.groups.form.name"))).toHaveValue("Saeon Industrial Group");
  await page.getByRole("dialog").getByRole("button", { name: t("common.cancel") }).click();

  await main.getByRole("button", { name: t("tenants.groups.assignOrg") }).click();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.groups.assignSubmit") }).click();
  await expect(main.getByText("Harbor Cloud Inc.").first()).toBeVisible();
  expect(stepUps.length).toBeGreaterThan(0);

  await main.getByRole("button", { name: t("tenants.groups.createAccount") }).click();
  const acctDialog = page.getByRole("dialog");
  await acctDialog.getByLabel(t("tenants.groups.accountName")).fill("Soyeon Kim");
  await acctDialog.getByRole("button", { name: t("tenants.groups.accountSubmit") }).click();
  await expect(page.getByRole("dialog").getByText("GRP9988776", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.code.close") }).first().click();

  await main.getByRole("button", { name: t("tenants.groups.revokeRole", { role: t("enum.platformGroupRole.GROUP_FINANCE") }) }).click();
  await expect(main.getByRole("status").first()).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Operators tab: passkey cancel suppresses alert, dialog resets on reopen, pending invite revokes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupPlatformMocks(page, { cancelPasskey: true });
  await page.goto("/platform");
  const main = page.getByRole("main");
  await main.getByRole("navigation", { name: t("tenants.tabs") }).getByRole("link", { name: t("tenants.tab.operators"), exact: true }).click();

  await main.getByRole("button", { name: t("tenants.operators.invite") }).click();
  const inviteDialog = page.getByRole("dialog");
  await inviteDialog.getByLabel(t("tenants.operators.form.name")).fill("Ghost Operator");
  await inviteDialog.getByRole("button", { name: t("tenants.operators.form.submit") }).click();
  await expect(inviteDialog.getByRole("alert")).toHaveCount(0);
  await inviteDialog.getByRole("button", { name: t("common.cancel") }).click();

  await main.getByRole("button", { name: t("tenants.operators.invite") }).click();
  await expect(page.getByRole("dialog").getByLabel(t("tenants.operators.form.name"))).toHaveValue("");
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: t("common.cancel") }).click();

  await main.locator(`[data-id="${THIRD_ID}"]`).click();
  await expect(main.getByRole("button", { name: t("tenants.operators.revoke") })).toBeEnabled();
  expect(fixture.unexpected).toEqual([]);
});

test("Operators tab: bound-passkey invite -> cop_ login link, reissue, pending/peer revoke", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, stepUps } = await setupPlatformMocks(page);
  await page.goto("/platform");
  const main = page.getByRole("main");
  await main.getByRole("navigation", { name: t("tenants.tabs") }).getByRole("link", { name: t("tenants.tab.operators"), exact: true }).click();

  await main.getByRole("button", { name: t("tenants.operators.invite") }).click();
  const inviteDialog = page.getByRole("dialog");
  await inviteDialog.getByLabel(t("tenants.operators.form.name")).fill("Doyun Lee");
  await inviteDialog.getByLabel(t("tenants.operators.form.login")).fill("doyun.lee@platform.test");
  await inviteDialog.getByRole("button", { name: t("tenants.operators.form.submit") }).click();
  expect(stepUps.at(-1)?.binding?.action_kind).toBe("OPERATOR_RECOVERY");
  expect(String(stepUps.at(-1)?.binding?.payload_hash ?? "")).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByRole("dialog").getByText("cop_InviteToken01", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.code.close") }).first().click();

  await main.locator(`[data-id="${ME_ID}"]`).click();
  await expect(main.getByRole("button", { name: t("tenants.operators.revoke") })).toBeDisabled();

  await main.locator(`[data-id="${THIRD_ID}"]`).click();
  await main.getByRole("button", { name: t("tenants.operators.reissue") }).click();
  await expect(page.getByRole("dialog").getByText("cop_ReissuedToken02", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.code.close") }).first().click();
  await main.getByRole("button", { name: t("tenants.operators.revoke") }).click();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.operators.revoke") }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  let rejectLast = true;
  await mockRoute(page, "post", "/api/platform/operators/{id}/revoke", (request) => {
    if (rejectLast) { rejectLast = false; return { status: 409, json: failure("last_platform_operator") }; }
    const found = makeOperators().find((o) => o.user_id === new URL(request.url()).pathname.split("/").at(-2)!);
    return found ? { status: 200, json: { ...found, status: "REVOKED", is_active: false } } : { status: 404, json: failure("not_found") };
  });
  await main.locator(`[data-id="${PEER_ID}"]`).click();
  await main.getByRole("button", { name: t("tenants.operators.revoke") }).click();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.operators.revoke") }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(t("common.failed.code.last_platform_operator"));
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.operators.revoke") }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/login#otp=cop_InviteToken01");
  await expect(page.getByLabel(t("auth.login.code"))).toHaveValue("cop_InviteToken01");
  await expect(page.locator("body")).not.toContainText("/10");
  expect(fixture.unexpected).toEqual([]);
});

test("Support tab: KPI filtering, request, maker-checker approve/409, start token, end", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, stepUps } = await setupPlatformMocks(page);
  await page.goto("/platform");
  const main = page.getByRole("main");
  await main.getByRole("navigation", { name: t("tenants.tabs") }).getByRole("link", { name: t("tenants.tab.support"), exact: true }).click();
  await expect(main.getByText(t("tenants.support.metadataNotice"))).toBeVisible();

  await main.getByRole("button", { name: new RegExp(t("supportAccess.state.ACTIVE")) }).click();
  await expect(main.locator(`[data-id="${SUP_3}"]`)).toBeVisible();
  await expect(main.locator(`[data-id="${SUP_1}"]`)).toHaveCount(0);
  await main.getByRole("button", { name: t("tenants.view.all"), exact: true }).click();
  await expect(main.locator(`[data-id="${SUP_1}"]`)).toBeVisible();

  await main.getByRole("button", { name: t("tenants.support.request") }).click();
  const reqDialog = page.getByRole("dialog");
  await reqDialog.getByLabel(t("tenants.support.form.ticketRef")).fill("INC-4021");
  await reqDialog.getByLabel(t("tenants.support.form.reason")).fill("Verify org hierarchy sync");
  await reqDialog.getByRole("button", { name: t("tenants.support.request") }).click();
  expect(stepUps.at(-1)?.binding?.action_kind).toBe("SUPPORT_SESSION");
  expect(String(stepUps.at(-1)?.binding?.payload_hash ?? "")).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(main.getByRole("button", { name: t("tenants.support.approve") })).toBeDisabled();

  let rejectNoSecond = true;
  await mockRoute(page, "post", "/api/platform/support-sessions/{id}/approve", (request) => {
    if (rejectNoSecond) { rejectNoSecond = false; return { status: 409, json: failure("support.refuse.no_second_operator") }; }
    return { status: 200, json: { id: new URL(request.url()).pathname.split("/").at(-2)!, state: "OPERATOR_APPROVED" } };
  });
  await main.locator(`[data-id="${SUP_1}"]`).click();
  await main.getByRole("button", { name: t("tenants.support.approve") }).click();
  await expect(main.getByRole("alert")).toContainText(t("support.refuse.no_second_operator"));
  await main.getByRole("button", { name: t("tenants.support.approve") }).click();

  await main.locator(`[data-id="${SUP_2}"]`).click();
  await main.getByRole("button", { name: t("tenants.support.start") }).click();
  await expect(page.getByRole("dialog").getByText("sup_bearer_once_secret_token", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: t("tenants.code.close") }).first().click();

  await main.locator(`[data-id="${SUP_3}"]`).click();
  await main.getByRole("button", { name: t("tenants.support.end") }).click();
  await expect(main.getByRole("status").first()).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Console /platform keeps zero >=2px header/tab shift across pending -> populated and pending -> 503", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const held = Promise.withResolvers<void>();
  const { fixture } = await setupPlatformMocks(page);
  await mockRoute(page, "get", "/api/platform/orgs", async () => { await held.promise; return { status: 200, json: makeOrgs() }; });
  await page.goto("/platform");
  const main = page.getByRole("main");
  const heading = main.getByRole("heading", { name: t("tenants.title"), level: 1 });
  const tabs = main.getByRole("navigation", { name: t("tenants.tabs") });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  await expect(tabs).toBeVisible();
  const beforeHeading = await heading.boundingBox(), beforeTabs = await tabs.boundingBox();
  held.resolve();
  await expect(main.getByText("Saeon Precision Co.").first()).toBeVisible();
  const afterHeading = await heading.boundingBox(), afterTabs = await tabs.boundingBox();
  expect(Math.abs((afterHeading?.y ?? 0) - (beforeHeading?.y ?? 0))).toBeLessThan(2);
  expect(Math.abs((afterTabs?.y ?? 0) - (beforeTabs?.y ?? 0))).toBeLessThan(2);

  const held503 = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/platform/orgs", async () => { await held503.promise; return { status: 503, json: failure("service_unavailable") }; });
  await page.goto("/platform");
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const preErrHeading = await heading.boundingBox();
  held503.resolve();
  await expect(main.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  const postErrHeading = await heading.boundingBox();
  expect(Math.abs((postErrHeading?.y ?? 0) - (preErrHeading?.y ?? 0))).toBeLessThan(2);
  expect(fixture.unexpected).toEqual([]);
});
