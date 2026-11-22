// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { chooseRadio } from "../flows";
import { test } from "../locale-fixture";
import { withFullPage } from "../shots";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { checklist, failure, id, screenAccess } from "./fixtures";
import { SAEON_HERO_ID, saeonUniverse } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));

const SHOT_ROOT = path.resolve("docs/ui-target/built/console");
const capture = async (page: Page, width: 1440 | 390, name: string, theme: "light" | "dark") => {
  if (process.env.CAPTURE_CONSOLE_SHOTS !== "1") return;
  const dir = path.join(SHOT_ROOT, String(width));
  mkdirSync(dir, { recursive: true });
  await withFullPage(page, () => page.screenshot({ path: path.join(dir, `${name}-${theme}.png`), fullPage: true }));
};

async function setupSettingsConsole(
  page: Page,
  options: {
    theme?: "light" | "dark";
    experience?: "console" | "baseline";
    canManage?: boolean;
    phase?: "OPERATING" | "SETUP";
    passkeyStepUpMode?: "ok" | "step_up_required" | "refused";
  } = {},
) {
  const { theme = "light", experience = "console", canManage = true, phase = "OPERATING", passkeyStepUpMode = "ok" } = options;
  const fixture = await setupConsoleSaeonPeople(page, { theme, experience, canManage, passkeyStepUpMode });
  const paths = ["/people", "/people/$id", "/people/numbering", "/people/job-titles", "/people/roster-fields", "/people/period-locks", "/settings/company-domain"];
  const entries = paths.flatMap(p => screenAccess(p, phase).entries);
  const deduped = entries.filter((e, i) => entries.findIndex(o => o.domain === e.domain && o.level === e.level && o.scope.kind === e.scope.kind) === i);
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...screenAccess("/people/numbering", phase), entries: deduped },
  });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: { ...checklist, phase, go_live_at: phase === "SETUP" ? null : checklist.go_live_at } });
  await mockRoute(page, "get", "/api/v1/employees/{id}/employee-number/history", {
    status: 200,
    json: [
      { id: id(501), employee_id: SAEON_HERO_ID, from_number: "90587", to_number: saeonUniverse.hero.employeeNumber, effective_date: "2024-03-01", reason_code: "NUMBERING_SCHEME_CHANGE", batch_id: null, changed_at: "2024-03-01T00:00:00Z", undone_at: null },
    ],
  });
  await mockRoute(page, "post", "/api/v1/employees/{id}/employee-number", {
    status: 200,
    json: { id: id(502), employee_id: SAEON_HERO_ID, from_number: saeonUniverse.hero.employeeNumber, to_number: "10999", effective_date: "2026-11-10", reason_code: "NUMBERING_SCHEME_CHANGE", batch_id: null, changed_at: "2026-11-10T00:00:00Z", undone_at: null },
  });
  await mockRoute(page, "get", "/api/v1/employee-number-rules", {
    status: 200,
    json: [{ scope_kind: "TENANT", scope_id: id(1), prefix: "10", width: 5, next_number: "10626" }],
  });
  await mockRoute(page, "put", "/api/v1/employee-number-rules", { status: 200, json: { scope_kind: "TENANT", scope_id: id(1), prefix: "10", width: 5, next_number: "10626" } });
  await mockRoute(page, "delete", "/api/v1/employee-number-rules", { status: 204 });
  await mockRoute(page, "get", "/api/v1/roster-fields", {
    status: 200,
    json: {
      can_manage: canManage,
      active_limit: 30,
      items: [
        { id: id(601), label: saeonUniverse.settings.rosterFields.lockerLabel, value_type: "TEXT", section: "PERSONAL", visibility: "MANAGERS", choices: [], active: true },
        { id: id(602), label: saeonUniverse.settings.rosterFields.uniformLabel, value_type: "CHOICE", section: "JOB", visibility: "MANAGERS", choices: [{ id: id(611), label: "M" }, { id: id(612), label: "L" }], active: true },
      ],
    },
  });
  await mockRoute(page, "patch", "/api/v1/roster-fields/{id}", {
    status: 200,
    json: { id: id(602), label: saeonUniverse.settings.rosterFields.uniformLabel, value_type: "CHOICE", section: "JOB", visibility: "MANAGERS", choices: [{ id: id(611), label: "M" }, { id: id(612), label: "L" }], active: true },
  });
  await mockRoute(page, "get", "/api/v1/job-titles", {
    status: 200,
    json: {
      can_manage: canManage,
      items: [
        { id: id(701), kind: "GRADE", label: saeonUniverse.grades.SENIOR_STAFF, grade_rank: 20, active: true },
        { id: id(702), kind: "TITLE", label: saeonUniverse.roles.TEAM_LEAD, grade_rank: 10, active: true },
        { id: id(703), kind: "JOB", label: saeonUniverse.settings.jobTitles.precisionLabel, grade_rank: null, active: false },
      ],
    },
  });
  await mockRoute(page, "patch", "/api/v1/job-titles/{id}", {
    status: 200,
    json: { id: id(702), kind: "TITLE", label: saeonUniverse.roles.TEAM_LEAD, grade_rank: 10, active: true },
  });
  return fixture;
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console identifiers & people settings (P3/P9) render cleanly at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupSettingsConsole(page, { theme });
      try {
        await page.goto(`/people/${SAEON_HERO_ID}/identifiers`);
        await expect(page.locator('[data-pattern="record"]')).toBeVisible();
        await expect(page.getByRole("main").locator("h1")).toHaveCount(1);
        await expect(page.getByRole("main")).toContainText(saeonUniverse.hero.rrnMasked);
        await fits(page, `/people/$id/identifiers ${width} ${theme}`);
        await expectAxe(page, `/people/$id/identifiers ${width} ${theme}`);
        await capture(page, width, "people-identifiers", theme);

        for (const [routePath, shotName, navLabel] of [
          ["/people/numbering", "people-numbering", "identifiers.numbering.title"],
          ["/people/roster-fields", "people-roster-fields", "rosterFields.title"],
          ["/people/job-titles", "people-job-titles", "shell.settings.titles"],
        ] as const) {
          await page.goto(routePath);
          await expect(page.locator('[data-pattern="settings"]')).toBeVisible();
          await expect(page.getByRole("main").locator("h1")).toHaveCount(1);
          await expect(page.getByRole("navigation", { name: t("shell.link.settings") }).getByRole("link", { name: t(navLabel) })).toHaveAttribute("aria-current", "page");
          await fits(page, `${routePath} ${width} ${theme}`);
          await expectAxe(page, `${routePath} ${width} ${theme}`);
          await capture(page, width, shotName, theme);
        }

        if (width === 390) {
          await page.setViewportSize({ width: 320, height: 844 });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow).toBeLessThanOrEqual(0);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console settings SidePane edit, focus return, read-only, 403 refusal, step-up RRN reveal, and baseline parity work", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });

  const okFixture = await setupSettingsConsole(page, { passkeyStepUpMode: "ok" });
  try {
    await page.goto("/people/roster-fields");
    const rfEditBtn = page.locator(`#rf-edit-${id(602)}`);
    await rfEditBtn.click();
    const rfPane = page.locator('aside[data-pane="record"]');
    await expect(rfPane).toBeVisible();
    await expect(rfPane.getByRole("form", { name: t("rosterFields.edit.title", { label: saeonUniverse.settings.rosterFields.uniformLabel }) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(rfPane).toHaveCount(0);
    await expect(rfEditBtn).toBeFocused();

    await page.goto("/people/job-titles");
    const jtEditBtn = page.locator(`#jt-edit-${id(702)}`);
    await jtEditBtn.click();
    const jtPane = page.locator('aside[data-pane="record"]');
    await expect(jtPane).toBeVisible();
    await expect(jtPane.getByRole("form", { name: t("titles.edit.title", { label: saeonUniverse.roles.TEAM_LEAD }) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(jtPane).toHaveCount(0);
    await expect(jtEditBtn).toBeFocused();

    await page.goto(`/people/${SAEON_HERO_ID}/identifiers`);
    await page.getByRole("button", { name: t("empCard.reveal.open", { field: t("empCard.f.rrn") }), exact: true }).click();
    const dialog = page.getByRole("dialog");
    await chooseRadio(dialog, new RegExp(saeonUniverse.reasonCodes.rrn_reveal[0]!.labelKo));
    await dialog.getByRole("button", { name: t("empCard.reveal.primary"), exact: true }).click();
    await expect(page.locator("code", { hasText: saeonUniverse.hero.rrn })).toBeVisible();
    expect(page.url()).not.toContain(saeonUniverse.hero.rrn);
    const storage = await page.evaluate(() => JSON.stringify({ ls: localStorage, ss: sessionStorage }));
    expect(storage).not.toContain(saeonUniverse.hero.rrn);
    expect(consoleErrors.join("\n")).not.toContain(saeonUniverse.hero.rrn);
    expect(okFixture.unexpected).toEqual([]);
  } finally {
    okFixture.release();
  }

  for (const mode of ["step_up_required", "refused"] as const) {
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const f = await setupSettingsConsole(page, { canManage: true, passkeyStepUpMode: mode });
    try {
      await page.goto(`/people/${SAEON_HERO_ID}/identifiers`);
      await page.getByRole("button", { name: t("empCard.reveal.open", { field: t("empCard.f.rrn") }), exact: true }).click();
      const dialog = page.getByRole("dialog");
      await chooseRadio(dialog, new RegExp(saeonUniverse.reasonCodes.rrn_reveal[0]!.labelKo));
      await dialog.getByRole("button", { name: t("empCard.reveal.primary"), exact: true }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(page.locator("code", { hasText: saeonUniverse.hero.rrn })).toHaveCount(0);
      expect(f.unexpected).toEqual([]);
    } finally {
      f.release();
    }
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const readOnly = await setupSettingsConsole(page, { canManage: false });
  try {
    await page.goto("/people/roster-fields");
    await expect(page.getByRole("main").getByRole("status")).toHaveText(t("rosterFields.denied"));
    await page.goto("/people/job-titles");
    await expect(page.getByRole("main").getByRole("status")).toHaveText(t("empFix.catalog.denied", { field: t("titles.list") }));
    expect(readOnly.unexpected).toEqual([]);
  } finally {
    readOnly.release();
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const denied = await setupSettingsConsole(page, { experience: "console" });
  await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/job-titles", { status: 403, json: failure("forbidden") });
  try {
    await page.goto(`/people/${SAEON_HERO_ID}/identifiers`);
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await page.goto("/people/job-titles");
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    expect(denied.unexpected).toEqual([]);
  } finally {
    denied.release();
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const base = await setupSettingsConsole(page, { experience: "baseline" });
  try {
    for (const p of [`/people/${SAEON_HERO_ID}/identifiers`, "/people/numbering", "/people/roster-fields", "/people/job-titles"]) {
      await page.goto(p);
      await expect(page.locator('[data-pattern]')).toHaveCount(0);
      await expect(page.locator("h1")).toBeVisible();
    }
    expect(base.unexpected).toEqual([]);
  } finally {
    base.release();
  }
});
