// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { shot, withFullPage } from "../shots";
import { accountScreens } from "../states/account";
import { accountReads } from "./account";
import { failure, id } from "./fixtures";
import { mockRoute } from "./route";
import {
  maskMobilePhone,
  saeonAdminToken,
  saeonHeroCertificates,
  saeonHeroProfile,
  saeonHeroUser,
  saeonUniverse,
} from "./saeon";
import { mockScreen } from "./screen";

type S = components["schemas"];

test.beforeAll(() => loadCatalog("ko"));

async function enableConsoleExperience(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, themeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
      Object.defineProperty(navigator.credentials, "get", {
        configurable: true,
        value: async () => {
          if (sessionStorage.getItem("cancel-passkey")) {
            throw new DOMException("Cancelled", "NotAllowedError");
          }
          return { toJSON: () => ({ id: "saeon-credential" }) };
        },
      });
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme },
  );
}

async function setupHeroProfile(page: Page, theme: "light" | "dark" = "light") {
  await enableConsoleExperience(page, theme);
  const fixture = await mockScreen(page, accountScreens[0], "populated");
  await accountReads(page, "save-unchanged");
  let hero = { ...saeonHeroUser(), sign_in_id: "hajun@saeon" };
  let profile = saeonHeroProfile();
  const certificates = saeonHeroCertificates();
  const revealCalls: string[] = [];
  const changeRequests: Array<{ field: string; body: Record<string, unknown> }> = [];
  const issuedKeys: string[] = [];
  const heroToken = saeonAdminToken();
  const payslipTitle = `${t("account.hub.payslip")} 2026-10-01 ~ 2026-10-31 · ${hero.employee_name}`;

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: heroToken });
  await mockRoute(page, "get", "/api/v1/users/me", () => ({ status: 200, json: hero }));
  await mockRoute(page, "patch", "/api/v1/users/me", request => {
    const body = request.postDataJSON() as { display_name?: string; phone?: string | null };
    hero = {
      ...hero,
      ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
    };
    return { status: 200, json: hero };
  });
  await mockRoute(page, "get", "/api/v1/me/profile", () => ({ status: 200, json: profile }));
  await mockRoute(page, "patch", "/api/v1/me/profile", request => {
    const body = request.postDataJSON() as S["UpdateMeProfileRequest"];
    if (body.phone !== undefined) {
      const masked = body.phone ? maskMobilePhone(body.phone) : null;
      profile = { ...profile, phone_masked: masked };
      hero = { ...hero, phone: masked };
    }
    if (body.emergency_contacts !== undefined) {
      const next = body.emergency_contacts.map(c => ({
        name: c.name,
        relation: c.relation,
        phone_masked: maskMobilePhone(c.phone),
      }));
      profile = {
        ...profile,
        emergency_contacts_registered: next.length > 0,
        emergency_contacts_count: next.length,
        emergency_contacts: next,
      };
    }
    return { status: 200, json: profile };
  });
  await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", {
    status: 200,
    json: {
      ceremony_id: "self-reveal-ceremony",
      challenge: { publicKey: { challenge: "Y2hhbGxlbmdl" } },
      expires_at: "2026-11-10T01:00:00Z",
      binding: {
        action_kind: "PII_REVEAL",
        object_id: hero.employee_id!,
        reason_key: "SELF_REVEAL:PHONE",
        replay_attempt: null,
      },
    },
  });
  await mockRoute(page, "post", "/api/v1/me/profile/reveal", request => {
    const body = request.postDataJSON() as S["SelfRevealRequest"];
    revealCalls.push(body.field);
    if (body.field === "PHONE") {
      return {
        status: 200,
        json: {
          employee_id: hero.employee_id!,
          field: "PHONE" as const,
          value: "+821000004821",
          display_seconds: 15,
        },
      };
    }
    if (body.field === "ADDRESS") {
      return {
        status: 200,
        json: {
          employee_id: hero.employee_id!,
          field: "ADDRESS" as const,
          value: {
            source: "JUSO",
            road_addr_part1: saeonUniverse.heroDetails.fullAddress,
            si_nm: saeonUniverse.hero.address.split(" ")[0],
            sgg_nm: saeonUniverse.hero.address.split(" ")[1],
            emd_nm: saeonUniverse.hero.address.split(" ")[2],
          },
          display_seconds: 15,
        },
      };
    }
    return {
      status: 200,
      json: {
        employee_id: hero.employee_id!,
        field: "EMERGENCY_CONTACTS" as const,
        value: [
          {
            name: saeonUniverse.heroDetails.emergencyContactName,
            relation: "SPOUSE",
            phone: "+821055559012",
          },
        ],
        display_seconds: 15,
      },
    };
  });
  await mockRoute(page, "post", "/api/v1/me/profile/change-requests", request => {
    const body = request.postDataJSON() as Record<string, unknown>;
    const field = String(body.field ?? "");
    changeRequests.push({ field, body });
    const cr = {
      id: id(400 + changeRequests.length),
      field: field as S["MeProfileResponse"]["open_change_requests"][number]["field"],
      status: "OPEN" as const,
      masked_summary: field === "address" ? saeonUniverse.hero.address : null,
      created_at: "2026-11-10T01:00:00Z",
    };
    profile = {
      ...profile,
      open_change_requests: [...profile.open_change_requests.filter(r => r.field !== field), cr],
    };
    return {
      status: 201,
      json: {
        id: cr.id,
        kind: "PROFILE_CORRECTION" as const,
        subject_type: "EMPLOYEE" as const,
        subject_id: hero.employee_id!,
        payload: body,
        reason_code: "OTHER" as const,
        requested_by: hero.id,
        assignee_role: "HR" as const,
        status: "OPEN" as const,
        review_required: true,
        created_at: cr.created_at,
      },
    };
  });
  await mockRoute(page, "get", "/api/v1/ref/address-search", request => {
    const q = new URL(request.url()).searchParams.get("q") ?? "";
    if (q.length < 2) return { status: 200, json: { status: "OK" as const, items: [], total: 0 } };
    return {
      status: 200,
      json: {
        status: "OK" as const,
        items: [
          {
            source: "JUSO" as const,
            bd_mgt_sn: "4122013000100010001000001",
            road_addr_part1: saeonUniverse.heroDetails.fullAddress.split(",")[0]!,
            jibun_addr: saeonUniverse.hero.address,
            zip_no: "17799",
            si_nm: saeonUniverse.hero.address.split(" ")[0]!,
            sgg_nm: saeonUniverse.hero.address.split(" ")[1]!,
            emd_nm: saeonUniverse.hero.address.split(" ")[2]!,
          },
        ],
        total: 1,
      },
    };
  });
  await mockRoute(page, "get", "/api/v1/me/certificates", () => ({
    status: 200,
    json: {
      items: certificates.map(c => ({
        id: c.id,
        employee_id: c.employee_id,
        name: c.snapshot.name,
        certificate_no: c.certificate_no,
        kind: c.kind,
        purpose: c.purpose,
        issued_at: c.issued_at,
        voided_at: c.voided_at,
        replaces_id: c.replaces_id,
      })),
      next_cursor: null,
    },
  }));
  await mockRoute(page, "get", "/api/v1/me/certificates/{id}", request => {
    const certId = new URL(request.url()).pathname.split("/").at(-1);
    const cert = certificates.find(c => c.id === certId) ?? certificates[0]!;
    return { status: 200, json: cert };
  });
  await mockRoute(page, "post", "/api/v1/me/certificates", request => {
    const key = request.headers()["idempotency-key"];
    if (key) issuedKeys.push(key);
    const body = request.postDataJSON() as S["SelfIssueCertificateRequest"];
    const nextCert: S["Certificate"] = {
      ...certificates[0]!,
      id: id(850 + certificates.length + 1),
      certificate_no: `HR-2026-0${120 + certificates.length}`,
      kind: body.kind,
      items: body.items,
      purpose: body.purpose,
      issued_at: "2026-11-10T09:00:00Z",
    };
    certificates.unshift(nextCert);
    return { status: 201, json: nextCert };
  });

  await mockRoute(page, "get", "/api/v2/me/leave", {
    status: 200,
    json: {
      balance: {
        employee_id: hero.employee_id!,
        name: hero.employee_name!,
        org_unit: hero.employee_org_unit ?? null,
        accrued_units: String(saeonUniverse.hero.leave.grantedDays),
        used_units: String(saeonUniverse.hero.leave.usedDays),
        remaining_units: String(saeonUniverse.hero.leave.remainingDays),
        filing_state: "ready",
        home_branch_id: hero.branch_ids[0] ?? id(4),
      },
      requests: { items: [], next_cursor: null },
    },
  });
  await mockRoute(page, "get", "/api/v1/me/inbox-docs", {
    status: 200,
    json: {
      items: [
        {
          id: id(301),
          recipient_user_id: hero.id,
          kind: "payslip",
          title: payslipTitle,
          source_kind: "payroll_run",
          source_id: id(302),
          locked: false,
          created_at: "2026-11-10T00:00:00Z",
          payslip_meta: {
            attribution_month: "2026-10",
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            pay_date: "2026-11-25",
            gross_won: 3567000,
            net_won: 3120000,
          },
        },
      ],
      next_cursor: null,
    },
  });
  await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", {
    status: 200,
    json: {
      id: id(301),
      recipient_user_id: hero.id,
      kind: "payslip",
      title: payslipTitle,
      source_kind: "payroll_run",
      source_id: id(302),
      locked: false,
      created_at: "2026-11-10T00:00:00Z",
      payload: {},
    },
  });
  await mockRoute(page, "get", "/api/v1/me/access-log", {
    status: 200,
    json: {
      items: [
        {
          event_id: id(501),
          occurred_at: "2026-11-03T02:00:00Z",
          actor_name: saeonUniverse.adminActor.name,
          actor_team: saeonUniverse.adminActor.unit,
          action: "employee.rrn_reveal",
          field: "RRN",
          reason_code: "SOCIAL_INSURANCE_FILING",
          target_type: "employee",
        },
      ],
      next_cursor: null,
    },
  });

  return {
    fixture,
    payslipTitle,
    revealCalls,
    changeRequests,
    issuedKeys,
    setProfile: (next: S["MeProfileResponse"]) => {
      profile = next;
    },
  };
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /account renders PhoneHub (P12) for Saeon employee at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const { fixture } = await setupHeroProfile(page, theme);
      try {
        await page.goto("/account");
        const hub = page.locator('[data-pattern="phone-hub"]');
        await expect(hub).toBeVisible();

        if (width === 390) {
          await expect(page.getByRole("heading", { level: 1, name: t("shell.profile"), exact: true })).toBeVisible();
          await expect(hub.locator("h1")).toHaveCount(0);
          await expect(page.getByRole("banner")).toContainText(saeonUniverse.hero.entityName);
          await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true })).toContainText(t("shell.profile"));
        } else {
          await expect(hub.getByRole("heading", { level: 1, name: t("shell.profile"), exact: true })).toBeVisible();
        }

        await expect(hub).toContainText(saeonUniverse.hero.name);
        await expect(hub).toContainText(t("enum.employeeStatus.ACTIVE"));
        await expect(hub).toContainText(`${saeonUniverse.hero.gradeLabel} · ${saeonUniverse.hero.roleLabel}`);
        await expect(hub).toContainText(saeonUniverse.hero.employeeNumber);
        await expect(hub).toContainText(saeonUniverse.hero.shortPlace.split(" › ").at(-1)!);
        await expect(hub).toContainText(saeonUniverse.hero.hireDate);
        await expect(hub).toContainText(t("account.hub.leaveRemaining", { days: saeonUniverse.hero.leave.remainingDays }));
        await expect(hub).toContainText(t("account.hub.payslipPayDate", { period: fmtMonth("2026-10"), date: "11-25" }));
        await expect(hub).toContainText(t("account.hub.certificates"));
        await expect(hub).toContainText(t("account.selfEdit.title"));
        await expect(hub).toContainText(saeonUniverse.hero.mobilePhoneMasked);
        await expect(hub).toContainText(t("account.selfEdit.emergency"));
        await expect(hub).toContainText(t("account.selfEdit.address"));
        await expect(hub).toContainText(saeonUniverse.hero.address);
        await expect(hub).toContainText(t("account.selfEdit.correctionPending"));
        await expect(hub).toContainText(t("account.selfEdit.bankAccount"));
        await expect(hub).toContainText(
          t("account.accessLog.viewedField", {
            actor: `${saeonUniverse.adminActor.unit} ${saeonUniverse.adminActor.name}`,
            field: t("account.accessLog.field.RRN"),
          }),
        );
        await expect(hub).toContainText(`${t("reason.rrn_reveal.SOCIAL_INSURANCE_FILING")} · 11-03`);

        for (const checkWidth of width === 390 ? [390, 320] : [1440]) {
          await page.setViewportSize({ width: checkWidth, height: width === 390 ? 844 : 900 });
          const metrics = await page.evaluate(vw => {
            const docFits = document.documentElement.scrollWidth <= vw;
            const selectsFit = [...document.querySelectorAll<HTMLSelectElement>("select")].every(el => {
              const rect = el.getBoundingClientRect();
              return rect.right <= vw + 1 && el.scrollWidth <= el.clientWidth + 2;
            });
            const buttonsSingleLine = [...document.querySelectorAll<HTMLElement>('main button, main a.btn')].map(el => {
              if (!el.offsetParent || (el.closest("ul") && !el.closest("section"))) return null;
              const rect = el.getBoundingClientRect();
              const ok = rect.right <= vw + 1 && rect.height <= 46;
              return ok ? null : { text: el.textContent?.trim(), width: Math.round(rect.width), height: Math.round(rect.height), right: Math.round(rect.right), vw };
            }).filter(Boolean);
            return { docFits, selectsFit, buttonsSingleLine };
          }, checkWidth);
          expect(metrics).toEqual({ docFits: true, selectsFit: true, buttonsSingleLine: [] });
        }
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });

        await withFullPage(page, () => shot(page, `profile--${width}-${theme}`));
        await fits(page, `Console Profile ${width} ${theme}`);
        await expectAxe(page, `Console Profile ${width} ${theme}`);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /account supports self-service edits, step-up PII reveal, change requests, certificates, and refusals", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture, payslipTitle, revealCalls, changeRequests, issuedKeys, setProfile } = await setupHeroProfile(
    page,
    "light",
  );
  try {
    await page.goto("/account");
    const hub = page.locator('[data-pattern="phone-hub"]');
    await expect(hub).toBeVisible();

    // 1. Step-up passkey reveal: cancelled passkey calls /reveal 0 times; approved reveal displays and clears on Escape.
    await page.evaluate(() => sessionStorage.setItem("cancel-passkey", "1"));
    await hub.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }).click();
    expect(revealCalls).toEqual([]);

    await page.evaluate(() => sessionStorage.removeItem("cancel-passkey"));
    await hub.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }).click();
    await expect(hub).toContainText("010-0000-4821");
    await expect(hub.getByRole("timer")).toBeVisible();
    const storageLeak = await page.evaluate(() => {
      const ls = Object.entries(localStorage).map(([k, v]) => `${k}:${v}`).join("|");
      const ss = Object.entries(sessionStorage).map(([k, v]) => `${k}:${v}`).join("|");
      return ls.includes("010-0000-4821") || ss.includes("010-0000-4821") || ls.includes("+821000004821");
    });
    expect(storageLeak).toBe(false);
    await page.keyboard.press("Escape");
    await expect(hub).not.toContainText("010-0000-4821");
    await expect(hub).toContainText(saeonUniverse.hero.mobilePhoneMasked);

    // Reveal again -> manual Hide button clears.
    await hub.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }).click();
    await expect(hub).toContainText("010-0000-4821");
    await hub.getByRole("button", { name: t("account.selfEdit.hide"), exact: true }).click();
    await expect(hub).not.toContainText("010-0000-4821");

    // Reveal ADDRESS -> click revealed plaintext to move focus off Hide -> Escape still re-masks PII.
    await hub.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.address") }), exact: true }).click();
    const revealedAddress = hub.getByText(saeonUniverse.heroDetails.fullAddress, { exact: true });
    await expect(revealedAddress).toBeVisible();
    await revealedAddress.click();
    await expect(hub.getByRole("button", { name: t("account.selfEdit.hide"), exact: true })).not.toBeFocused();
    await page.keyboard.press("Escape");
    await expect(hub).not.toContainText(saeonUniverse.heroDetails.fullAddress);
    await expect(hub).toContainText(saeonUniverse.hero.address);

    // 2. Edit mobile phone via PATCH /api/v1/me/profile (masked values rejected client-side).
    const selfSection = hub.locator('section[aria-label="' + t("account.selfEdit.title") + '"], section:has(h2:text-is("' + t("account.selfEdit.title") + '"))');
    const editButtons = selfSection.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true });
    await editButtons.nth(0).click();
    const phoneDialog = page.getByRole("dialog", { name: t("account.selfEdit.phoneEditTitle"), exact: true });
    const phoneInput = phoneDialog.getByLabel(t("account.selfEdit.phone"));
    await phoneInput.fill(saeonUniverse.hero.mobilePhoneMasked);
    await expect(phoneInput).toHaveAttribute("aria-invalid", "true");
    await expect(phoneDialog).toContainText(t("account.selfEdit.emergencyPhoneInvalid"));
    await phoneDialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await expect(phoneDialog).toBeVisible();
    await phoneInput.fill("010-9876-5432");
    await phoneDialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await expect(phoneDialog).toHaveCount(0);
    await expect(hub).toContainText(maskMobilePhone("010-9876-5432"));

    // 3. Edit emergency contacts with required contact_notified checkbox.
    await editButtons.nth(1).click();
    const emergencyDialog = page.getByRole("dialog", { name: t("account.selfEdit.emergencyEditTitle"), exact: true });
    await emergencyDialog.getByLabel(t("account.selfEdit.emergencyPhone")).fill("010-2222-3333");
    await emergencyDialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await expect(emergencyDialog.getByRole("alert")).toContainText(t("account.selfEdit.emergencyNotifiedRequired"));
    await emergencyDialog.getByRole("checkbox", { name: t("account.selfEdit.emergencyNotified") }).check();
    await emergencyDialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await expect(emergencyDialog).toHaveCount(0);

    // 4. Boolean-only bank account attestation request (zero raw account inputs).
    await editButtons.nth(2).click();
    const bankDialog = page.getByRole("dialog", { name: t("account.selfEdit.bankEditTitle"), exact: true });
    await expect(bankDialog.getByRole("textbox")).toHaveCount(1); // Only optional note field, zero account number input!
    await expect(bankDialog.locator("input")).toHaveCount(1);
    await bankDialog.getByRole("button", { name: t("account.selfEdit.addressSubmit"), exact: true }).click();
    await expect(bankDialog).toHaveCount(0);
    expect(changeRequests.some(r => r.field === "bank_account_registered" && typeof r.body.bank_account_registered === "boolean")).toBe(true);

    // 5. Address change request when no open address request exists.
    setProfile(saeonHeroProfile({ open_change_requests: [] }));
    await page.reload();
    await selfSection.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).nth(2).click();
    const addrDialog = page.getByRole("dialog", { name: t("account.selfEdit.addressEditTitle"), exact: true });
    await addrDialog.getByRole("textbox", { name: new RegExp(`^${t("account.selfEdit.address")}`) }).fill(saeonUniverse.hero.address.slice(0, 5));
    await addrDialog.getByRole("button", { name: t("account.selfEdit.addressPick"), exact: true }).first().click();
    await addrDialog.getByRole("button", { name: t("account.selfEdit.addressSubmit"), exact: true }).click();
    await expect(addrDialog).toHaveCount(0);
    expect(changeRequests.some(r => r.field === "address")).toBe(true);

    // 6. Self-service certificates sheet: list, preview, and issue with Idempotency-Key.
    await hub.getByRole("button", { name: new RegExp(`^${t("account.hub.certificates")}`) }).click();
    const certDialog = page.getByRole("dialog", { name: t("account.certificates.title"), exact: true });
    await expect(certDialog).toContainText(saeonUniverse.heroDetails.certificates[0]!.certificateNo);
    await certDialog.getByLabel(t("empDoc.certificate.purpose")).fill(saeonUniverse.heroDetails.certificates[0]!.purpose);
    await certDialog.getByRole("button", { name: t("account.certificates.issueCommit"), exact: true }).click();
    await expect(certDialog).toContainText(t("empDoc.certificate.attest"));
    expect(issuedKeys).toHaveLength(1);
    await certDialog.getByRole("button", { name: t("account.certificates.backToList"), exact: true }).click();
    await certDialog.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
    await expect(certDialog).toHaveCount(0);

    // 7. Payslip sheet + 403 refusal on /api/v1/me/profile.
    const payslipTrigger = hub.getByRole("button", { name: new RegExp(`^${t("account.hub.payslip")}`) });
    await payslipTrigger.click();
    const payslipDialog = page.getByRole("dialog", { name: t("account.hub.payslipSheetTitle"), exact: true });
    await expect(payslipDialog).toContainText(payslipTitle);
    await payslipDialog.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();

    await mockRoute(page, "get", "/api/v1/me/profile", { status: 403, json: failure("forbidden") });
    await page.reload();
    await expect(hub.getByRole("heading", { name: t("account.selfEdit.refused.title"), exact: true })).toBeVisible();
    await fits(page, "Console Profile self-edit refused");
    await expectAxe(page, "Console Profile self-edit refused");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /account phone edit remains dismissible on uncertain 500 or aborted write", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture } = await setupHeroProfile(page, "light");
  let patchMode: "error500" | "abort" = "error500";
  await page.route("**/api/v1/me/profile", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    if (patchMode === "abort") return route.abort("failed");
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(failure("internal_error")),
    });
  });

  try {
    await page.goto("/account");
    const hub = page.locator('[data-pattern="phone-hub"]');
    await expect(hub).toBeVisible();

    await hub.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: t("account.selfEdit.phoneEditTitle"), exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(t("account.selfEdit.phone")).fill("010-9876-4821");
    await dialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();

    const status = dialog.getByRole("status");
    await expect(status).toBeVisible();
    await expect(status).toContainText(t("requestOutcome.checking"));
    await expect(dialog.getByRole("button", { name: t("account.selfEdit.clearPhone"), exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true })).toBeDisabled();
    const dismiss = dialog.getByRole("button", { name: t("composer.dismiss"), exact: true });
    expect(await dismiss.isDisabled()).toBe(false);
    await dismiss.click();
    await expect(dialog).toHaveCount(0);

    patchMode = "abort";
    await page.reload();
    await hub.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).first().click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(t("account.selfEdit.phone")).fill("010-9876-4821");
    await dialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText(t("requestOutcome.checking"));
    const dismiss2 = dialog.getByRole("button", { name: t("composer.dismiss"), exact: true });
    expect(await dismiss2.isDisabled()).toBe(false);
    await dismiss2.focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
