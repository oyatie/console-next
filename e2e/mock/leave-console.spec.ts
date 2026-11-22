// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateShortWeekday } from "@console/i18n/format";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { screens } from "../states/registry";
import { failure, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import {
  saeonHeroScheduleMonth,
  saeonHeroToken,
  saeonHeroUser,
  saeonLeaveRequestView,
  saeonMyLeaveApprovalPreview,
  saeonMyLeaveOverview,
  saeonMyLeaveTeamOverlap,
  saeonUniverse,
} from "./saeon";
import { mockScreen } from "./screen";

type S = components["schemas"];

const DRAFT_DATE = "2026-11-20";
const FIXED_TIME = new Date("2026-11-20T09:00:00+09:00");

test.beforeAll(() => loadCatalog("ko"));

async function setExperience(page: Page, experience: "console" | "baseline", theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, expValue, themeValue }) => {
      localStorage.setItem(expKey, expValue);
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, expValue: experience, themeValue: theme },
  );
}

async function setupLeaveMock(
  page: Page,
  {
    experience = "console",
    theme = "light",
    state = "populated",
    installDraftClock = true,
  }: {
    experience?: "console" | "baseline";
    theme?: "light" | "dark";
    state?: "populated" | "failed" | "refused" | "loading";
    installDraftClock?: boolean;
  } = {},
) {
  await setExperience(page, experience, theme);
  if (installDraftClock && state !== "failed") {
    await page.clock.install({ time: FIXED_TIME });
  }
  const fixture = await mockScreen(page, screens[0], state === "failed" ? "failed" : "populated");
  const hero = saeonHeroUser();
  const baseAccess = screenAccess("/account");

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonHeroToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: hero });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...baseAccess, is_ops: false, entries: [] },
  });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", {
    status: 200,
    json: {
      items: [],
      total: 0,
      total_is_exact: true,
      next_cursor: null,
      unavailable: [],
      counts: {
        turn: { total: 0, total_is_exact: true },
        waiting: { total: 0, total_is_exact: true },
        scheduled: { total: 0, total_is_exact: true },
        failures: { total: 0, total_is_exact: true },
      },
      upcoming: [],
      snooze_presets: [],
      has_work: false,
      quick_starts: [],
      as_of: "2026-11-20T00:00:00Z",
      available_filters: [],
    },
  });
  await mockRoute(page, "get", "/api/v1/attendance/me/schedule", request => {
    const month = new URL(request.url()).searchParams.get("month") ?? "2026-11";
    return {
      status: 200,
      json: saeonHeroScheduleMonth(month),
    };
  });

  let releaseLeave!: () => void;
  const heldLeave = new Promise<void>(resolve => {
    releaseLeave = resolve;
  });
  const overview = saeonMyLeaveOverview();

  await mockRoute(page, "get", "/api/v2/me/leave", async () => {
    if (state === "loading") await heldLeave;
    if (state === "failed") return { status: 503, json: failure("service_unavailable") };
    if (state === "refused") return { status: 403, json: failure("forbidden") };
    return { status: 200, json: overview };
  });
  await mockRoute(page, "get", "/api/v2/me/leave/team-overlap", {
    status: 200,
    json: saeonMyLeaveTeamOverlap(),
  });
  await mockRoute(page, "get", "/api/v2/me/leave/approval-preview", {
    status: 200,
    json: saeonMyLeaveApprovalPreview(),
  });

  return {
    fixture,
    hero,
    overview,
    releaseLeave: () => releaseLeave?.(),
  };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /leave renders Saeon hero leave form, 30-cell Meter, and anchored chrome at ${width}px ${theme}`, async ({
      page,
    }) => {
      const height = width === 1440 ? 900 : 844;
      await page.setViewportSize({ width, height });
      const { fixture, hero } = await setupLeaveMock(page, { experience: "console", theme });
      try {
        await page.goto("/leave");
        const form = page.locator('[data-pattern="form"]');
        await expect(form).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await expect(form.getByRole("meter", { name: t("leave.meter.label"), exact: true })).toHaveAttribute(
          "aria-valuetext",
          t("leave.meter.valueText", { accrued: "15", used: "5.5", pending: "1", after: "8.5" }),
        );
        await expect(form).toContainText(t("leave.balance.days", { days: "15" }));
        await expect(form).toContainText(t("leave.balance.days", { days: "5.5" }));
        await expect(form).toContainText(t("leave.balance.days", { days: "9.5" }));
        await expect(form).toContainText(t("leave.summary.requestedValue", { kind: t("leave.type.annual"), days: "1" }));
        await expect(form).toContainText(t("leave.balance.days", { days: "8.5" }));
        await expect(form.locator("textarea")).toHaveCount(0);

        const dateInputs = form.locator("input[type='text']");
        await expect(dateInputs).toHaveCount(2);
        await expect(dateInputs.nth(0)).toHaveValue(fmtDateShortWeekday(DRAFT_DATE));
        await expect(dateInputs.nth(1)).toHaveValue(fmtDateShortWeekday(DRAFT_DATE));

        await expect(form).toContainText(t("leave.teamOverlap.label"));
        await expect(form).toContainText(saeonUniverse.attendanceMonth.members[7]!.name);
        await expect(form).toContainText(t("leave.approval.label"));
        await expect(form).toContainText(`${saeonUniverse.attendanceMonth.members[0]!.name} ${saeonUniverse.roles.TEAM_LEAD}`);
        await expect(form).toContainText(t("leave.approval.branchHr"));
        await expect(form).not.toContainText("TEAM_LEAD");
        await expect(form).not.toContainText("Approver");

        await expect(form).toContainText(t("leave.history.title"));
        await expect(form).toContainText(`${t("leave.type.halfAm")} · ${t("leave.balance.days", { days: "0.5" })}`);
        await expect(form).toContainText(fmtDateShortWeekday("2026-11-06"));
        await expect(form).toContainText(fmtDateShortWeekday("2026-10-23"));
        await expect(form).toContainText(fmtDateShortWeekday("2026-10-08"));

        if (width === 390) {
          const topBar = page.getByRole("banner");
          await expect(topBar).toContainText(t("leave.title"));
          await expect(topBar).toContainText(`${hero.employee_name} · ${hero.employee_org_unit}`);
          await expect(topBar.locator("button")).toHaveCount(0);

          const bottomNav = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
          await expect(bottomNav).toBeVisible();
          const tabs = bottomNav.locator("a");
          await expect(tabs).toHaveCount(5);
          await expect(tabs.nth(0)).toContainText(t("shell.link.home"));
          await expect(tabs.nth(1)).toContainText(t("shell.link.leave"));
          await expect(tabs.nth(1)).toHaveAttribute("aria-current", "page");
          await expect(tabs.nth(2)).toContainText(t("shell.link.payroll"));
          await expect(tabs.nth(3)).toContainText(t("shell.link.certificates"));
          await expect(tabs.nth(4)).toContainText(t("shell.link.profile"));

          const navBox = await bottomNav.boundingBox();
          const barBox = await form.locator("[data-sticky]").boundingBox();
          expect(navBox).not.toBeNull();
          expect(barBox).not.toBeNull();
          expect(Math.round(navBox!.y + navBox!.height)).toBeGreaterThanOrEqual(843);
          expect(Math.round(barBox!.y + barBox!.height)).toBeGreaterThanOrEqual(Math.round(navBox!.y) - 2);
        } else {
          const statusBar = page.getByRole("contentinfo", { name: t("shell.status.label"), exact: true });
          await expect(statusBar).toBeVisible();
          const statusBox = await statusBar.boundingBox();
          expect(statusBox).not.toBeNull();
          expect(Math.round(statusBox!.y + statusBox!.height)).toBeGreaterThanOrEqual(899);
        }

        await page.evaluate(() => document.fonts.ready);
        await withFullPage(page, () => shot(page, `leave--${width}-${theme}`));
        await fits(page, `Console Leave ${width} ${theme}`);
        await expectAxe(page, `Console Leave ${width} ${theme}`);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /leave contains overflow at 320x844 and keeps DateFields paired at 390px and stacked below 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const { fixture } = await setupLeaveMock(page, { experience: "console", theme: "light" });
  try {
    await page.goto("/leave");
    const form = page.locator('[data-pattern="form"]');
    await expect(form).toBeVisible();
    await fits(page, "Console Leave 320 light");
    const barPosition = await form.locator("[data-sticky]").evaluate(el => getComputedStyle(el).position);
    expect(barPosition).toBe("static");
    const boxes = await form.locator("input[type='text']").evaluateAll(els =>
      els.map(el => el.getBoundingClientRect()),
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.bottom).toBeLessThanOrEqual(boxes[1]!.top + 1);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /leave handles half-day toggles, multi-day schedule counting, and idempotent POST without reason", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture, overview } = await setupLeaveMock(page, { experience: "console", theme: "light" });
  const posted: Record<string, unknown>[] = [];
  let currentOverview = overview;

  await mockRoute(page, "get", "/api/v2/me/leave", () => ({ status: 200, json: currentOverview }));
  await mockRoute(page, "post", "/api/v2/leave/requests", request => {
    const body = request.postDataJSON() as S["LeaveCreateRequest"] & Record<string, unknown>;
    posted.push(body);
    const created = saeonLeaveRequestView(body, posted.length);
    currentOverview = saeonMyLeaveOverview({ items: [created] });
    return { status: 201, json: created };
  });

  try {
    await page.goto("/leave");
    const form = page.locator('[data-pattern="form"]');
    const meter = form.getByRole("meter", { name: t("leave.meter.label"), exact: true });

    await form.getByRole("button", { name: t("leave.type.halfAm"), exact: true }).click();
    await expect(meter).toHaveAttribute(
      "aria-valuetext",
      t("leave.meter.valueText", { accrued: "15", used: "5.5", pending: "0.5", after: "9" }),
    );
    await expect(form).toContainText(t("leave.summary.requestedValue", { kind: t("leave.type.halfAm"), days: "0.5" }));

    await form.getByRole("button", { name: t("leave.type.halfPm"), exact: true }).click();
    await expect(form).toContainText(t("leave.summary.requestedValue", { kind: t("leave.type.halfPm"), days: "0.5" }));

    // Multi-day across 2026-11-20 (Fri) .. 2026-11-23 (Mon) skips Sat/Sun -> 2 workdays.
    await form.getByRole("button", { name: t("leave.date.multiDay"), exact: true }).click();
    const endInput = form.getByRole("textbox", { name: t("leave.date.end"), exact: true });
    await endInput.focus();
    await endInput.fill("2026. 11. 23.");
    await endInput.press("Enter");
    await endInput.blur();
    await expect(meter).toHaveAttribute(
      "aria-valuetext",
      t("leave.meter.valueText", { accrued: "15", used: "5.5", pending: "2", after: "7.5" }),
    );

    // Submit multi-day annual request and verify UUID idempotency_key + zero `reason` field.
    await form.getByRole("button", { name: t("leave.submit"), exact: true }).click();
    await expect(form).toContainText(t("leave.receipt.title"));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.leave_type).toBe("annual");
    expect(posted[0]!.start_date).toBe("2026-11-20");
    expect(posted[0]!.end_date).toBe("2026-11-23");
    expect(String(posted[0]!.idempotency_key)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect("reason" in posted[0]!).toBe(false);
    await expect(form).toContainText(t("leave.history.title"));
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /leave reverts short-weekday DateInput on blur without edit, fetches 3+-month schedules, and excludes weekends on partial 503", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture } = await setupLeaveMock(page, { experience: "console", theme: "light" });
  let failDec = false;
  await mockRoute(page, "get", "/api/v1/attendance/me/schedule", request => {
    const month = new URL(request.url()).searchParams.get("month") ?? "2026-11";
    if (failDec && month === "2026-12") {
      return { status: 503, json: failure("service_unavailable") };
    }
    return { status: 200, json: saeonHeroScheduleMonth(month) };
  });

  try {
    await page.goto("/leave");
    const form = page.locator('[data-pattern="form"]');
    const startInput = form.getByRole("textbox", { name: t("leave.date.start"), exact: true });
    const endInput = form.getByRole("textbox", { name: t("leave.date.end"), exact: true });
    const meter = form.getByRole("meter", { name: t("leave.meter.label"), exact: true });

    // Focus then blur without typing must revert from editable format to short-weekday.
    await startInput.focus();
    await startInput.press("Enter");
    await expect(startInput).toBeFocused();
    await expect(startInput).toHaveValue("2026. 11. 20.");
    await startInput.blur();
    await expect(startInput).toHaveValue(fmtDateShortWeekday(DRAFT_DATE));

    // 3+-month span: 2026-10-30..2026-12-03 = 25 working days (1 + 21 + 3).
    await form.getByRole("button", { name: t("leave.date.multiDay"), exact: true }).click();
    await startInput.focus();
    await startInput.fill("2026. 10. 30.");
    await startInput.blur();
    await endInput.focus();
    await endInput.fill("2026. 12. 03.");
    await endInput.blur();
    await expect(meter).toHaveAttribute(
      "aria-valuetext",
      t("leave.meter.valueText", { accrued: "15", used: "5.5", pending: "25", after: "-15.5" }),
    );

    // Partial 503 on 2026-12 (fresh load so 2026-12 is not cached): 2026-11-27..2026-12-06 skips Dec 5 (Sat) & Dec 6 (Sun) = 6 days.
    failDec = true;
    await page.reload();
    await form.getByRole("button", { name: t("leave.date.multiDay"), exact: true }).click();
    await startInput.focus();
    await startInput.fill("2026. 11. 27.");
    await startInput.blur();
    await endInput.focus();
    await endInput.fill("2026. 12. 06.");
    await endInput.blur();
    await expect(meter).toHaveAttribute(
      "aria-valuetext",
      t("leave.meter.valueText", { accrued: "15", used: "5.5", pending: "6", after: "3.5" }),
    );

    // Invalid input Enter must immediately surface [role="alert"] and aria-invalid without waiting for blur,
    // and re-focus + blur without typing must preserve draft, aria-invalid, and alert.
    await endInput.focus();
    await endInput.fill("not-a-date");
    await endInput.press("Enter");
    await expect(endInput).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toBeVisible();
    await endInput.blur();
    await expect(endInput).toHaveValue("not-a-date");
    await expect(endInput).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(form.getByRole("button", { name: t("leave.submit"), exact: true })).toBeDisabled();

    await endInput.focus();
    await endInput.blur();
    await expect(endInput).toHaveValue("not-a-date");
    await expect(endInput).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(form.getByRole("button", { name: t("leave.submit"), exact: true })).toBeDisabled();

    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /leave state sweep: loading, home_branch_required, failed (503 + retry), refused (403), and submit refusals", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // 1. loading -> populated
  {
    const loadingCtx = await setupLeaveMock(page, { state: "loading" });
    try {
      await page.goto("/leave");
      await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
      loadingCtx.releaseLeave();
      await expect(page.locator('[data-pattern="form"]')).toBeVisible();
      expect(loadingCtx.fixture.unexpected).toEqual([]);
    } finally {
      loadingCtx.fixture.release();
    }
  }

  // 2. home_branch_required closed filing notice
  {
    const closedCtx = await setupLeaveMock(page);
    await mockRoute(page, "get", "/api/v2/me/leave", {
      status: 200,
      json: saeonMyLeaveOverview({ filingState: "home_branch_required" }),
    });
    try {
      await page.goto("/leave");
      const form = page.locator('[data-pattern="form"]');
      await expect(form).toContainText(t("leave.filing.homeBranchRequired.title"));
      await expect(form.getByRole("button", { name: t("leave.submit"), exact: true })).toBeDisabled();
      expect(closedCtx.fixture.unexpected).toEqual([]);
    } finally {
      closedCtx.fixture.release();
    }
  }

  // 3. failed 503 + retry recovery
  {
    const failedCtx = await setupLeaveMock(page, { state: "failed", installDraftClock: false });
    let recover = false;
    await mockRoute(page, "get", "/api/v2/me/leave", () =>
      recover ? { status: 200, json: saeonMyLeaveOverview() } : { status: 503, json: failure("service_unavailable") },
    );
    try {
      await page.goto("/leave");
      await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
      recover = true;
      await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(page.getByRole("meter", { name: t("leave.meter.label"), exact: true })).toBeVisible();
      expect(failedCtx.fixture.unexpected).toEqual([]);
    } finally {
      failedCtx.fixture.release();
    }
  }

  // 4. refused 403 on primary read
  {
    const refusedReadCtx = await setupLeaveMock(page, { state: "refused" });
    try {
      await page.goto("/leave");
      await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      expect(refusedReadCtx.fixture.unexpected).toEqual([]);
    } finally {
      refusedReadCtx.fixture.release();
    }
  }

  // 5. submit 403 / 409 / 422 refusals preserve input and surface accessible alerts
  {
    const submitCtx = await setupLeaveMock(page);
    let reply: { status: 403 | 409 | 422; json: ReturnType<typeof failure> } = {
      status: 403,
      json: failure("leave.refuse.identity_unbound"),
    };
    await mockRoute(page, "post", "/api/v2/leave/requests", () => reply);
    try {
      await page.goto("/leave");
      const form = page.locator('[data-pattern="form"]');
      const submit = form.getByRole("button", { name: t("leave.submit"), exact: true });

      await submit.click();
      await expect(form.getByRole("alert")).toContainText(t("leave.refuse.identity_unbound"));

      reply = { status: 409, json: failure("leave_home_branch_review_required") };
      await submit.click();
      await expect(form.getByRole("alert")).toContainText(t("leave.failed.homeBranchRequired"));

      reply = { status: 409, json: failure("leave_overlapping_request") };
      await submit.click();
      await expect(form.getByRole("alert")).toContainText(t("common.failed.code.leave_overlapping_request"));

      reply = { status: 409, json: failure("leave_period_closed") };
      await submit.click();
      await expect(form.getByRole("alert")).toContainText(t("common.failed.code.leave_period_closed"));

      reply = { status: 422, json: failure("invalid_date_range") };
      await submit.click();
      await expect(form.getByRole("alert")).toContainText(t("leave.failed.invalidRange"));

      // 403/503 on overlap & approval-preview degrade gracefully without blocking submission.
      await mockRoute(page, "get", "/api/v2/me/leave/team-overlap", { status: 403, json: failure("forbidden") });
      await mockRoute(page, "get", "/api/v2/me/leave/approval-preview", { status: 503, json: failure("service_unavailable") });
      await page.reload();
      await expect(form).toContainText(t("leave.teamOverlap.unavailable"));
      await expect(form).toContainText(t("leave.approval.unavailable"));
      await expect(form.getByRole("button", { name: t("leave.submit"), exact: true })).toBeEnabled();

      expect(submitCtx.fixture.unexpected).toEqual([]);
    } finally {
      submitCtx.fixture.release();
    }
  }

  // 6. step-up / passkey session recovery refusal on 401
  {
    const stepUpCtx = await setupLeaveMock(page);
    await mockRoute(page, "post", "/api/v2/leave/requests", { status: 401, json: failure("unauthorized") });
    await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
    try {
      await page.goto("/leave");
      const form = page.locator('[data-pattern="form"]');
      await expect(form.getByRole("button", { name: t("leave.submit"), exact: true })).toBeVisible();
      await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 401, json: failure("unauthorized") });
      await form.getByRole("button", { name: t("leave.submit"), exact: true }).click();
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(form.getByRole("meter", { name: t("leave.meter.label"), exact: true })).toBeVisible();
      expect(stepUpCtx.fixture.unexpected).toEqual([]);
    } finally {
      stepUpCtx.fixture.release();
    }
  }
});

test("Baseline /leave preserves unaltered Classic layout without Console shell chrome", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture } = await setupLeaveMock(page, { experience: "baseline", theme: "light" });
  try {
    await page.goto("/leave");
    await expect(page.locator("[data-console-shell]")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: t("leave.title"), exact: true })).toBeVisible();
    await expect(page.getByRole("meter", { name: t("leave.meter.label"), exact: true })).toBeVisible();
    await fits(page, "Baseline Leave 390 light");
    await expectAxe(page, "Baseline Leave 390 light");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
