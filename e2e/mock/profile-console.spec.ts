// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { shot, withFullPage } from "../shots";
import { accountScreens } from "../states/account";
import { accountReads } from "./account";
import { failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { saeonAdminToken, saeonHeroUser, saeonUniverse } from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function enableConsoleExperience(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, themeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme },
  );
}

async function setupHeroProfile(page: Page, theme: "light" | "dark" = "light") {
  await enableConsoleExperience(page, theme);
  const fixture = await mockScreen(page, accountScreens[0], "populated");
  await accountReads(page, "save-unchanged");
  let hero = { ...saeonHeroUser(), sign_in_id: "hajun@saeon" };
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
  await mockRoute(page, "get", "/api/v2/me/leave", {
    status: 200,
    json: {
      balance: {
        employee_id: hero.employee_id!,
        name: hero.employee_name!,
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
  await mockRoute(page, "get", "/api/v1/change-requests", {
    status: 200,
    json: {
      items: [
        {
          id: id(401),
          kind: "PROFILE_CORRECTION",
          subject_type: "EMPLOYEE",
          subject_id: hero.employee_id!,
          payload: { changes: { address: saeonUniverse.hero.address } },
          reason_code: "OTHER",
          requested_by: hero.id,
          assignee_role: "HR",
          status: "OPEN",
          review_required: false,
          created_at: "2026-11-02T01:00:00Z",
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
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
  return { fixture, payslipTitle };
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
        await expect(hub).toContainText(`${saeonUniverse.hero.gradeLabel} · ${saeonUniverse.hero.roleLabel}`);
        await expect(hub).toContainText(saeonUniverse.hero.employeeNumber);
        await expect(hub).toContainText(saeonUniverse.hero.shortPlace.split(" › ").at(-1)!);
        await expect(hub).toContainText(t("account.hub.leaveRemaining", { days: saeonUniverse.hero.leave.remainingDays }));
        await expect(hub).toContainText(fmtMonth("2026-10"));
        await expect(hub).toContainText(saeonUniverse.hero.mobilePhoneMasked);
        await expect(hub).toContainText(t("empCard.f.address"));
        await expect(hub).toContainText(saeonUniverse.hero.address);
        await expect(hub).toContainText(t("account.selfEdit.correctionPending"));
        await expect(hub).toContainText(
          t("account.accessLog.viewedField", {
            actor: `${saeonUniverse.adminActor.unit} ${saeonUniverse.adminActor.name}`,
            field: t("account.accessLog.field.RRN"),
          }),
        );
        await expect(hub).toContainText(`${t("reason.rrn_reveal.SOCIAL_INSURANCE_FILING")} · 11-03`);

        // Ensure selects and action controls stay inside the column and never wrap vertically at 390px or 320px.
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

        // Verify visual-maturity craft rules: no card-in-pane borders on passkey rows, custom select chevron, no underlined hub links.
        const craftCheck = await page.evaluate(vw => {
          const passkeyRows = [...document.querySelectorAll<HTMLTableRowElement>('section[aria-labelledby="acct-passkeys"] tbody tr')];
          const passkeyBorderFree = passkeyRows.every(tr => {
            const st = getComputedStyle(tr);
            return st.borderTopWidth === "0px" && st.borderLeftWidth === "0px" && st.borderRightWidth === "0px";
          });
          const selectsCustom = [...document.querySelectorAll<HTMLSelectElement>("select.field__input")].every(sel => {
            const st = getComputedStyle(sel);
            return st.appearance === "none" && st.backgroundImage !== "none";
          });
          const underlinedSectionLinks = [...document.querySelectorAll<HTMLAnchorElement>("main section a")]
            .filter(a => !a.classList.contains("btn") && getComputedStyle(a).textDecorationLine !== "none")
            .map(a => ({ text: a.textContent?.trim(), cls: a.className, deco: getComputedStyle(a).textDecorationLine }));
          return { vw, passkeyBorderFree, selectsCustom, underlinedSectionLinks };
        }, width);
        expect(craftCheck).toEqual({
          vw: width,
          passkeyBorderFree: true,
          selectsCustom: true,
          underlinedSectionLinks: [],
        });

        if (width === 390) {
          const passkeyFact = page.locator('section[aria-labelledby="acct-passkeys"] tbody tr [data-card="fact"]').first();
          const passkeyTitle = page.locator('section[aria-labelledby="acct-passkeys"] tbody tr [data-card="title"]').first();
          const factBox = await passkeyFact.boundingBox();
          const titleBox = await passkeyTitle.boundingBox();
          expect(factBox).not.toBeNull();
          expect(titleBox).not.toBeNull();
          expect(Math.abs(factBox!.x - titleBox!.x)).toBeLessThanOrEqual(1);
        }

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

test("Console /account phone edit mutation, payslip sheet, empty/loading/failed/refused states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture, payslipTitle } = await setupHeroProfile(page, "light");
  try {
    await page.goto("/account");
    const hub = page.locator('[data-pattern="phone-hub"]');
    await expect(hub).toBeVisible();

    // Edit mobile phone number -> masked display updates cleanly.
    await hub.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: t("account.selfEdit.phoneEditTitle"), exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(t("account.selfEdit.phone")).fill("010-9876-5432");
    await dialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(hub).toContainText("010-9876-5432");

    // Open issued payslip preview dialog via quick-navigation link.
    const payslipTrigger = hub.getByRole("button", { name: new RegExp(`^${t("account.hub.payslip")}`) });
    await payslipTrigger.click();
    const payslipDialog = page.getByRole("dialog", { name: t("account.hub.payslipSheetTitle"), exact: true });
    await expect(payslipDialog).toBeVisible();
    await expect(payslipDialog).toContainText(payslipTitle);
    await expectAxe(page, "Console Profile payslip sheet");
    await payslipDialog.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
    await expect(payslipDialog).toHaveCount(0);
    await expect(payslipTrigger).toBeFocused();

    // Access-log 403 refusal and payslip sheet 403 refusal are compact and dismissible.
    await mockRoute(page, "get", "/api/v1/me/access-log", { status: 403, json: failure("forbidden") });
    await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", { status: 403, json: failure("forbidden") });
    await page.reload();
    await expect(hub.getByRole("heading", { name: t("account.accessLog.refused.title"), exact: true })).toBeVisible();
    await expect(hub.getByText(t("common.denied.title.plain"))).toHaveCount(0);
    await expect(hub.getByRole("link", { name: t("common.denied.back") })).toHaveCount(0);
    await expect(hub.getByRole("button", { name: t("common.denied.request") })).toHaveCount(0);
    await fits(page, "Console Profile access-log refused");
    await expectAxe(page, "Console Profile access-log refused");

    await payslipTrigger.click();
    await expect(payslipDialog).toBeVisible();
    await expect(payslipDialog.getByRole("heading", { name: t("common.denied.panel"), exact: true })).toBeVisible();
    await expect(payslipDialog.getByRole("link", { name: t("common.denied.back") })).toHaveCount(0);
    await expect(payslipDialog.getByRole("button", { name: t("common.denied.request") })).toHaveCount(0);
    const dismiss403 = payslipDialog.getByRole("button", { name: t("composer.dismiss"), exact: true });
    await expect(dismiss403).toBeVisible();
    await expect(dismiss403).toBeEnabled();
    await expectAxe(page, "Console Profile payslip sheet refused");
    await dismiss403.click();
    await expect(payslipDialog).toHaveCount(0);
    await expect(payslipTrigger).toBeFocused();

    // Access-log 503 and payslip sheet 503 are compact and dismissible.
    await mockRoute(page, "get", "/api/v1/me/access-log", { status: 503, json: failure("service_unavailable") });
    await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", { status: 503, json: failure("service_unavailable") });
    await page.reload();
    await expect(hub.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
    await expect(hub.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
    await fits(page, "Console Profile access-log failed");
    await expectAxe(page, "Console Profile access-log failed");

    await payslipTrigger.click();
    await expect(payslipDialog).toBeVisible();
    const dismiss503 = payslipDialog.getByRole("button", { name: t("composer.dismiss"), exact: true });
    await expect(dismiss503).toBeVisible();
    await expect(payslipDialog.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(payslipDialog.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
    await expect(dismiss503).toBeEnabled();
    await expectAxe(page, "Console Profile payslip sheet failed");
    await dismiss503.click();
    await expect(payslipDialog).toHaveCount(0);
    await expect(payslipTrigger).toBeFocused();

    // Empty state for access-log, change-requests, and payslips.
    await mockRoute(page, "get", "/api/v1/me/access-log", { status: 200, json: { items: [], next_cursor: null } });
    await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [], total: 0, limit: 10, offset: 0 } });
    await mockRoute(page, "get", "/api/v1/me/inbox-docs", { status: 200, json: { items: [], next_cursor: null } });
    await page.reload();
    await expect(hub.getByText(t("account.accessLog.empty"), { exact: true })).toBeVisible();
    await fits(page, "Console Profile empty");
    await expectAxe(page, "Console Profile empty");

    // Failed read on /api/v1/users/me -> error + retry restores.
    await mockRoute(page, "get", "/api/v1/users/me", { status: 503, json: failure("service_unavailable") });
    await page.reload();
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    await expectAxe(page, "Console Profile failed");

    // Refused read (403) -> denial gate.
    await mockRoute(page, "get", "/api/v1/users/me", { status: 403, json: failure("forbidden") });
    await page.reload();
    await expect(page.getByRole("main").getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await expectAxe(page, "Console Profile refused");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /account phone edit remains dismissible on uncertain 500 or aborted write", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture } = await setupHeroProfile(page, "light");
  let patchMode: "error500" | "abort" = "error500";
  await page.route("**/api/v1/users/me", async route => {
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

    // Case 1: PATCH returns 500 while re-read mask stays 010-••••-4821 -> status banner shown, submit disabled, dismiss button enabled and closes dialog.
    await hub.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
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

    // Case 2: Fresh load, PATCH aborts while re-read mask stays 010-••••-4821 -> Escape also dismisses cleanly.
    patchMode = "abort";
    await page.reload();
    await expect(hub).toBeVisible();
    await hub.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
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
