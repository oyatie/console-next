// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY, THEME_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { accessPerson, accessRole, accessScreens, mockAccessScreen } from "../states/access";
import { screens } from "../states/registry";
import { AT, authz, failure, id, modules, token, user } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminToken, saeonAdminUser, saeonOrgStructure } from "./saeon";
import saeon from "./saeon-universe.json" with { type: "json" };
import { mockScreen } from "./screen";

type S = components["schemas"];
const CAPTURE = process.env.CAPTURE_ACCESS_SETTINGS_SCREENSHOTS === "1";

const saeonActorUser = (): S["CurrentUser"] => ({
  ...saeonAdminUser(),
  sign_in_id: "seoyeon.moon@saeon.test",
});

async function applySaeonShellIdentity(page: Page) {
  const actor = saeonActorUser();
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: actor });
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: modules.ready });
}

async function applySaeonAccessFixtures(page: Page) {
  await applySaeonShellIdentity(page);
  const company = saeon.entities[0]!.name;
  const people = [
    { ...saeon.hero, id: id(100), employeeId: id(1100), place: saeon.hero.shortPlace, email: "hajun.yoon@saeon.test" },
    { ...saeon.statusSamples.exited, id: id(101), employeeId: id(1101), email: "seongmin.park@saeon.test" },
    { ...saeon.statusSamples.onLeave, id: id(102), employeeId: id(1102), email: "songyi.lee@saeon.test" },
  ];
  const accounts: S["UserSummary"][] = people.map((person) => ({
    ...user,
    id: person.id,
    display_name: person.name,
    employee_id: person.employeeId,
    employee_name: person.name,
    employee_number: person.employeeNumber,
    employee_company: company,
    employee_org_unit: person.place,
    employee_position: saeon.grades[person.gradeCode as keyof typeof saeon.grades] ?? null,
    employee_link_status: "LINKED",
    sign_in_id: person.email,
    tenant: saeonAdminUser().tenant,
  }));
  const grants: S["AccessGrant"][] = accounts.map((account, idx) => ({
    id: id(3001 + idx),
    account_id: account.id,
    account_display_name: account.display_name,
    account_employee_number: account.employee_number,
    account_active: true,
    account_has_passkey: true,
    role_id: accessRole.id,
    role_name_ko: saeon.accessConsole.roleName,
    scope: { kind: "TENANT", include_descendants: true },
    valid_from: AT,
    valid_to: "2027-01-01T00:00:00Z",
    effective_in_setup: false,
    enforcement: "ENFORCED",
    reason_code: "OTHER",
    granted_by: saeonActorUser().id,
    granted_at: AT,
  }));
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: saeonOrgStructure() });
  await mockRoute(page, "get", "/api/v1/access/ops", { status: 200, json: { account_id: id(20), display_name: saeon.accessConsole.opsAccountName } });
  await mockRoute(page, "get", "/api/v1/access/roles", { status: 200, json: [{ ...accessRole, name_ko: saeon.accessConsole.readOnlyRole, holder_count: accounts.length }] });
  await mockRoute(page, "get", "/api/v1/access/grants", async (request) => {
    const query = new URL(request.url()).searchParams;
    return { status: 200, json: grants.filter((g) => !query.has("role_id") || g.role_id === query.get("role_id")) };
  });
  await mockRoute(page, "get", "/api/v1/users", async (request) => {
    const query = new URL(request.url()).searchParams;
    const q = (query.get("search") ?? query.get("q"))?.toLowerCase() ?? "";
    const matches = accounts.filter((a) => [a.display_name, a.employee_name, a.employee_number, a.sign_in_id].some((v) => v?.toLowerCase().includes(q)));
    const limit = Number(query.get("limit") ?? 200);
    const offset = Number(query.get("offset") ?? 0);
    return { status: 200, json: { items: matches.slice(offset, offset + limit), total: matches.length, limit, offset } };
  });
  await mockRoute(page, "get", "/api/v1/access/people/{id}", async (request) => {
    const accountId = new URL(request.url()).pathname.split("/").at(-1);
    const account = accountId === id(20)
      ? { ...user, id: id(20), display_name: saeon.accessConsole.opsAccountName, is_tenant_ops: true, tenant: saeonAdminUser().tenant }
      : accounts.find((a) => a.id === accountId);
    return account ? { status: 200, json: accessPerson(account) } : { status: 404, json: failure("not_found") };
  });
}

async function setConsoleExperience(page: Page) {
  await page.addInitScript((key: string) => {
    localStorage.setItem(key, "console");
  }, EXPERIENCE_KEY);
}

async function captureThemeShots(page: Page, screen: string, width: 1440 | 390) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    if (theme === "dark") {
      const toggle = page.getByRole("button", { name: t("shell.theme.toDark"), exact: true });
      if (await toggle.count()) await toggle.first().click();
    } else {
      const toggle = page.getByRole("button", { name: t("shell.theme.toLight"), exact: true });
      if (await toggle.count()) await toggle.first().click();
    }
    await page.evaluate(([value, key]) => {
      localStorage.setItem(key, value);
      document.documentElement.dataset.theme = value;
    }, [theme, THEME_KEY] as const);
    await fits(page, `${screen}/${width}/${theme}`);
    await expectAxe(page, `${screen}/${width}/${theme}`);
    if (CAPTURE) {
      const dir = resolve("docs/ui-target/built/console", String(width));
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: resolve(dir, `${screen}-${theme}.png`), fullPage: true });
    }
  }
}

async function mockPrivacyConsoleReads(page: Page) {
  const receipt = {
    id: "request-1",
    receipt_no: "RR-2026-001",
    detail: saeon.privacyConsole.requestDetail,
    status: "RECEIVED" as const,
    receipt: { controller: "TENANT" as const, received_on: "2026-11-01", identity_at: "2026-11-01T00:00:00Z" },
    kinds: { ACCESS: { due: { on: "2026-11-11", without_delay: false, rule: null }, decisions: [] } },
  };
  await mockRoute(page, "get", "/api/v1/privacy/rights-requests/{id}", {
    status: 200,
    json: { subject_name: saeon.hero.name, as_of: "2026-11-05", request: receipt },
  });
  await mockRoute(page, "get", "/api/v1/privacy/rights-requests/options", {
    status: 200,
    json: {
      subject_user_id: saeonActorUser().id,
      as_of: "2026-11-05",
      controllers: [{ code: "TENANT" }],
      kinds: [{ code: "ACCESS", due_on: "2026-11-22", without_delay: false }],
      detail_max_length: 2000,
      reply_email_masked: "m***@saeon.test",
    },
  });
  await mockRoute(page, "get", "/api/v1/privacy/rights-requests/mine", {
    status: 200,
    json: { items: [receipt], next_cursor: null, as_of: "2026-11-05" },
  });
  await mockRoute(page, "get", "/api/v1/me/access-log", request => {
    const cursor = new URL(request.url()).searchParams.get("cursor");
    return {
      status: 200,
      json: cursor
        ? {
            items: [{
              event_id: id(92),
              actor_name: saeon.privacyConsole.secondaryActor,
              actor_team: saeon.adminActor.unit,
              field: "ADDRESS",
              action: "VIEW",
              reason_code: "DATA_SUBJECT_ACCESS",
              occurred_at: AT,
              target_type: "EMPLOYEE",
            }],
            next_cursor: null,
          }
        : {
            items: [{
              event_id: id(91),
              actor_name: saeon.adminActor.name,
              actor_team: saeon.adminActor.unit,
              field: "PHONE",
              action: "VIEW",
              reason_code: "IDENTITY_VERIFICATION",
              occurred_at: AT,
              target_type: "EMPLOYEE",
            }],
            next_cursor: "page-2",
          },
    };
  });
  await mockRoute(page, "get", "/api/v1/settings", {
    status: 200,
    json: {
      can_change: false,
      items: [
        {
          key: "people.void_pii_retention",
          kind: { type: "int", unit: "days" },
          default: 30,
          value: 30,
          looser_when: "higher",
          governance: "tenant",
          legal_basis: null,
          version: "code_default",
          effective_from: null,
          scheduled: [],
          source: { layer: "code_default", scope_entity_id: null },
          chain: [],
        },
        {
          key: "display.experience",
          kind: { type: "code", allowed: ["baseline", "console"] },
          default: "baseline",
          value: "console",
          looser_when: "neutral",
          governance: "tenant",
          legal_basis: null,
          version: { override: id(1) },
          effective_from: null,
          scheduled: [],
          source: { layer: "tenant", scope_entity_id: null },
          chain: [],
        },
      ],
    },
  });
}

async function mockSettingsSummaryReads(page: Page) {
  await mockRoute(page, "get", "/api/v1/tenant/company-domain/request", { status: 200, json: { pending_domain: null } });
  await mockRoute(page, "get", "/api/v1/employee-number-rules", { status: 200, json: [{ scope_kind: "TENANT", scope_id: id(1), prefix: "E-", width: 4, next_number: "E-0100" }] });
  await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: false, items: [] } });
  await mockRoute(page, "get", "/api/v1/roster-fields", { status: 200, json: { can_manage: false, active_limit: 20, items: [] } });
  await mockRoute(page, "get", "/api/v1/period-locks", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/settings", {
    status: 200,
    json: {
      can_change: false,
      items: [
        {
          key: "approval.policy.leave",
          kind: { type: "code", allowed: ["direct", "route"] },
          default: "direct",
          value: "route",
          looser_when: "lower",
          governance: "tenant",
          legal_basis: null,
          version: "code_default",
          effective_from: null,
          scheduled: [],
          source: { layer: "code_default", scope_entity_id: null },
          chain: [],
        },
        {
          key: "display.experience",
          kind: { type: "code", allowed: ["baseline", "console"] },
          default: "baseline",
          value: "console",
          looser_when: "neutral",
          governance: "tenant",
          legal_basis: null,
          version: { override: id(1) },
          effective_from: null,
          scheduled: [],
          source: { layer: "tenant", scope_entity_id: null },
          chain: [],
        },
      ],
    },
  });
}

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390] as const) {
  test(`login renders SignInPattern, scrubs #otp= hash without auto-submit, and hides /signup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setConsoleExperience(page);
    const fixture = await mockScreen(page, screens[0], "populated");
    const authPosts: string[] = [];
    await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 401, json: failure("unauthenticated") });
    await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
    await page.route("**/api/v1/auth/otp/**", route => {
      authPosts.push(route.request().url());
      return route.fulfill({ status: 400, json: failure("bad_request") });
    });

    await page.goto("/login#otp=cop_SecretTokenCase123");
    await expect(page.locator('[data-pattern="sign-in"]')).toBeVisible();
    await expect(page.locator('a[href*="/signup"]')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe("");
    const codeInput = page.getByLabel(t("common.oneTimeCode"), { exact: true });
    await expect(codeInput).toBeVisible();
    await expect(codeInput).toHaveValue("cop_SecretTokenCase123");
    await expect(page.getByText(/\/10$/)).toHaveCount(0);
    expect(authPosts).toEqual([]);

    await captureThemeShots(page, "login", width);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`setup-passkey renders SignInPattern cleanly at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setConsoleExperience(page);
    const fixture = await mockScreen(page, screens[0], "populated");
    const claims = { sub: user.id, org: authz.org_id, enrollment: true, exp: Math.floor(Date.now() / 1000) + 3600 };
    await mockRoute(page, "post", "/api/v1/auth/token/refresh", {
      status: 200,
      json: {
        ...token(),
        access_token: `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`,
        requires_passkey_setup: true,
        privacy_consent_accepted: false,
      },
    });

    await page.goto("/setup-passkey");
    await expect(page.locator('[data-pattern="sign-in"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: t("auth.setup.title"), exact: true })).toBeVisible();
    await captureThemeShots(page, "setup-passkey", width);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`settings hub renders SettingsPattern cleanly at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setConsoleExperience(page);
    const fixture = await mockScreen(page, screens[0], "populated");
    await applySaeonShellIdentity(page);
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: saeonActorUser().id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [], decisions: {} } });
    await mockSettingsSummaryReads(page);
    await page.goto("/settings");
    await expect(page.locator('[data-pattern="settings"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: t("shell.link.settings"), exact: true })).toBeVisible();
    await captureThemeShots(page, "settings", width);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`privacy renders SettingsPattern sections, paged access-log, retention, and record pane at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setConsoleExperience(page);
    const fixture = await mockScreen(page, screens[0], "populated");
    await applySaeonShellIdentity(page);
    await mockPrivacyConsoleReads(page);

    await page.goto("/account/privacy");
    await expect(page.locator('[data-pattern="settings"]')).toBeVisible();
    await expect(page.getByText("RR-2026-001", { exact: true })).toBeVisible();
    await expect(page.locator("#privacy-access-log").getByText(new RegExp(saeon.adminActor.name))).toBeVisible();
    await expect(page.getByText(t("account.privacy.retention.item.voidPii"), { exact: true })).toBeVisible();

    await captureThemeShots(page, "privacy", width);

    await page.getByRole("button", { name: t("account.privacy.accessLog.more"), exact: true }).click();
    await expect(page.getByText(new RegExp(saeon.privacyConsole.secondaryActor))).toBeVisible();

    await page.getByText("RR-2026-001", { exact: true }).click();
    await expect(page.locator('[data-pane="record"]')).toBeVisible();
    await expect(page.locator('[data-pane="record"]').getByText(saeon.privacyConsole.requestDetail, { exact: true })).toBeVisible();

    await page.goto("/account/privacy/intake/request-1");
    await expect(page.locator('[data-pattern="record"]')).toBeVisible();
    await fits(page, `privacy-intake/${width}`);
    await expectAxe(page, `privacy-intake/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

if (CAPTURE) {
  for (const width of [1440, 390] as const) {
    for (const [key, screen, url] of [
      ["access-roles", accessScreens[1], "/access/roles"],
      ["access-grants", accessScreens[0], "/access/grants"],
      ["access-bulk", accessScreens[2], "/access/grants/bulk"],
      ["access-ready", accessScreens[3], "/access/ready"],
      ["access-person", accessScreens[7], `/access/people/${id(20)}`],
    ] as const) {
      test(`capture ${key} console screenshot at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await setConsoleExperience(page);
        const fixture = await mockAccessScreen(page, screen, "populated", "OPERATING");
        try {
          await applySaeonAccessFixtures(page);
          await page.goto(url);
          await page.waitForLoadState("networkidle");
          await captureThemeShots(page, key, width);
          expect(fixture.unexpected).toEqual([]);
        } finally {
          fixture.release();
        }
      });
    }
  }
}

test("tenant CodeDialog renders #otp= invite link (not ?otp=) and lazy QR SVG", async ({ page }) => {
  await setConsoleExperience(page);
  const fixture = await mockScreen(page, screens[0], "populated");
  const vendorClaims = { sub: id(999), platform: true, exp: Math.floor(Date.now() / 1000) + 3600 };
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", {
    status: 200,
    json: { ...token(), access_token: `h.${Buffer.from(JSON.stringify(vendorClaims)).toString("base64url")}.s` },
  });
  await mockRoute(page, "get", "/api/platform/users/me", {
    status: 200,
    json: { ...user, id: id(999), display_name: "Operator", roles: ["PLATFORM_ADMIN"] },
  });
  await mockRoute(page, "get", "/api/platform/orgs", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
  await mockRoute(page, "get", "/api/platform/company-domain", { status: 200, json: { available: true, alias_days: 30 } });
  await mockRoute(page, "post", "/api/platform/orgs", {
    status: 201,
    json: {
      org: { id: id(50), slug: "newco", name: "NewCo", group_id: null, group_slug: null, group_name: null, status: "ACTIVE", created_at: AT, updated_at: AT },
      admin_user_id: id(51),
      otp: "ABCDE-FGHJK",
      admin_otp_expires_at: AT,
      admin_sign_in_id: "admin@newco.test",
    },
  });

  await page.goto("/platform");
  await page.getByRole("button", { name: t("tenants.create"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t("tenants.form.name")).fill("NewCo");
  await dialog.getByLabel(t("tenants.form.slug")).fill("newco");
  await expect(dialog.getByText(t("tenants.form.available"))).toBeVisible();
  await dialog.getByRole("button", { name: t("tenants.form.submit"), exact: true }).click();

  await expect(dialog.getByText(/\/login#otp=ABCDE-FGHJK$/)).toBeVisible();
  await expect(dialog.getByText(/\?otp=/)).toHaveCount(0);
  await expect(dialog.locator(`svg[role="img"][aria-label="${t("common.inviteQrLabel")}"]`)).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
