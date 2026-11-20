// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import type { paths } from "@console/api/schema";
import { i18n, loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { screens } from "../states/registry";
import { homeSetupChecklist } from "../states/home-setup";
import { previewData } from "./onboarding";
import { failure, id, inbox, screenAccess, user } from "./fixtures";
import { mockRoute } from "./route";
import {
  saeonAdminToken,
  saeonAdminUser,
  saeonApprovalOrgChange,
  saeonEmployeeFacets,
  saeonOrgStructure,
  saeonUniverse,
  saeonWorklistInbox,
} from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function enableConsoleExperience(page: Page, theme: "light" | "dark" = "light", locale: "ko" | "en" = "ko") {
  await page.addInitScript(
    ({ expKey, themeValue, localeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", localeValue);
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme, localeValue: locale },
  );
}

async function setupConsoleSaeonWorklist(
  page: Page,
  theme: "light" | "dark" = "light",
  locale: "ko" | "en" = "ko",
  extraItems: ReturnType<typeof saeonWorklistInbox>["items"] = [],
) {
  await enableConsoleExperience(page, theme, locale);
  const fixture = await mockScreen(page, screens[0], "populated");
  const baseInbox = saeonWorklistInbox();
  const inboxData = extraItems.length > 0 ? { ...baseInbox, items: [...baseInbox.items, ...extraItems] } : baseInbox;
  const orgDetail = saeonApprovalOrgChange();
  const structure = saeonOrgStructure();
  const orgUnits: paths["/api/v1/org-units"]["get"]["responses"]["200"]["content"]["application/json"]["items"] =
    structure.entities.flatMap(entity =>
      (entity.children ?? []).flatMap(site =>
        (site.children ?? []).map(dept => ({
          id: dept.id,
          name: dept.name,
          kind: dept.kind === "SITE" ? ("SITE" as const) : ("DEPARTMENT" as const),
          parentId: site.id,
          status: "ACTIVE" as const,
          effectiveFrom: "2020-01-01",
          headcount: dept.headcount,
          updatedAt: "2026-11-10T09:00:00+09:00",
        })),
      ),
    );
  const team2 = saeonUniverse.entities[0]!.workplaces[1]!.departments[2]!.split(" › ").at(-1)!;
  const team3 = saeonUniverse.entities[0]!.workplaces[1]!.departments[3]!.split(" › ").at(-1)!;
  orgUnits.push(
    {
      id: "00000000-0000-4000-8400-000000000002",
      name: team2,
      kind: "DEPARTMENT",
      parentId: structure.entities[0]!.children![0]!.id,
      status: "ACTIVE",
      effectiveFrom: "2020-01-01",
      headcount: saeonUniverse.approval.beforeHeadcount,
      updatedAt: "2026-11-10T09:00:00+09:00",
    },
    {
      id: "00000000-0000-4000-8400-000000000003",
      name: team3,
      kind: "DEPARTMENT",
      parentId: structure.entities[0]!.children![0]!.id,
      status: "ACTIVE",
      effectiveFrom: "2026-11-10",
      headcount: saeonUniverse.approval.transferredCount,
      updatedAt: "2026-11-10T09:00:00+09:00",
    },
  );

  const orgAccess = screenAccess("/org");
  const peopleAccess = screenAccess("/people");
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...orgAccess, entries: [...orgAccess.entries, ...peopleAccess.entries] },
  });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: saeonEmployeeFacets() });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: structure });
  await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: orgUnits } });
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: orgDetail });
  const leaveMock = saeonUniverse.worklist.items.find(item => item.id === "leave-app-1")!;
  await mockRoute(page, "get", "/api/v1/approvals/{id}", {
    status: 200,
    json: {
      id: "00000000-0000-4000-8600-000000000006",
      box: "pending",
      title: leaveMock.title,
      summary: leaveMock.subject,
      document_no: "AP-2026-0192",
      decision_refusal: null,
      source: { key: "leave", label: t("home.attention.approvals") },
      status: { key: "IN_APPROVAL" },
      requester: { id: "00000000-0000-4000-8000-000000000021", name: leaveMock.subject.split(" · ")[0]! },
      effective_date: "2026-12-01",
      requested_at: "2026-11-09T09:00:00+09:00",
      facts: [{ key: "period", label: t("approvals.field.effectiveDate"), value: "2026-12-01 ~ 2027-11-30" }],
      route: [
        {
          id: "00000000-0000-4000-8700-000000000101",
          role_key: "hr",
          assignee: `${saeonUniverse.adminActor.name} · ${saeonUniverse.adminActor.unit}`,
          state: "current",
        },
      ],
      viewer: { kind: "org_change", id: "00000000-0000-4000-8600-000000000006" },
      body: [],
      revision: 1,
      fingerprint: "leave-fp-1",
      consequence: "final",
      opinion_max: 500,
      my_actions: {
        kind: "approve",
        reject: { consequence: "request_ends", reason_domain: "org_change_reject" },
      },
    },
  });
  await mockRoute(page, "get", "/api/v1/me/action-inbox/reference", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/me/action-inbox/done", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", request => {
    const query = new URL(request.url()).searchParams;
    const attention = query.get("attention");
    const filter = query.get("filter");
    const snoozed = query.get("snoozed");
    if (filter === "notices" || snoozed === "only") {
      return { status: 200, json: { ...inboxData, items: [] } };
    }
    if (filter === "waiting") {
      return { status: 200, json: { ...inboxData, items: inboxData.items.slice(0, 2) } };
    }
    const items =
      attention === "approvals"
        ? inboxData.items.filter(item => item.kind === "org_change_approve" || item.kind === "approval")
        : attention === "today"
          ? inboxData.items.filter(item => item.days_remaining === 0)
          : attention === "overdue"
            ? inboxData.items.filter(item => (item.days_remaining ?? 0) < 0)
            : inboxData.items;
    return { status: 200, json: { ...inboxData, items } };
  });
  return { fixture, orgDetail };
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console Home renders Worklist (P1) with Saeon worklist, schedule, lower bands, and decision pane at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupConsoleSaeonWorklist(page, theme);
      try {
        await page.goto(width === 1440 ? "/?sel=OC-2026-0418" : "/");
        const worklist = page.locator('[data-pattern="worklist"]');
        const queueTable = worklist.getByRole("grid", { name: t("home.inbox.title"), exact: true });
        await expect(worklist).toBeVisible();
        await expect(page.locator("[data-deadline-strip]")).toBeVisible();
        await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);
        await expect(page.getByRole("meter")).toHaveCount(5);
        await expect(worklist.getByRole("table", { name: t("home.worklist.opsTitle"), exact: true }).locator("tbody tr")).toHaveCount(2);

        if (width === 1440) {
          await expect(page.getByRole("banner")).toContainText(
            `${saeonUniverse.adminActor.name} · ${saeonUniverse.adminActor.unit} ${saeonUniverse.adminActor.grade}`,
          );
          await expect(page.getByRole("banner")).not.toContainText(user.display_name);
          await expect(page.getByRole("navigation", { name: t("shell.tabs.label"), exact: true })).not.toContainText("23");
          await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
          await expect(worklist.getByRole("link", { name: t("home.inbox.viewInbox"), exact: true })).toHaveCount(0);
          const orgRow = queueTable.locator('tbody tr[data-id="OC-2026-0418"]');
          const leaveRow = queueTable.locator('tbody tr[data-id="leave-app-1"]');
          await expect(orgRow.getByRole("button", { name: t("uiWorklist.reject"), exact: true })).toBeVisible();
          await expect(orgRow.getByRole("button", { name: t("uiWorklist.approve"), exact: true })).toBeVisible();
          await expect(leaveRow.getByRole("button", { name: t("uiWorklist.reject"), exact: true })).toBeVisible();
          await expect(leaveRow.getByRole("button", { name: t("uiWorklist.approve"), exact: true })).toBeVisible();
          await expect(queueTable.getByRole("button", { name: t("home.inbox.snooze") })).toHaveCount(0);

          const peopleTable = worklist.getByRole("table", { name: t("home.worklist.peopleCheck"), exact: true });
          await expect(peopleTable).toContainText(
            t("home.worklist.peopleSubMissing", { field: t("empCard.reg.item.address") }),
          );
          await expect(peopleTable).toContainText(t("home.worklist.personCount", { count: 353 }));
          await expect(peopleTable).toContainText(t("home.worklist.probationEnding"));
          await expect(peopleTable).toContainText(t("home.worklist.personCount", { count: 43 }));

          const recordPane = page.locator('aside[data-pane="record"]');
          await expect(recordPane).toBeVisible();
          await expect(page.locator("[data-decision-pane]")).toBeVisible();
          await expect(recordPane).toContainText(t("home.worklist.personCount", { count: 18 }));
          await expect(recordPane).toContainText(t("home.worklist.personCount", { count: 30 }));
          await expect(recordPane).toContainText(t("orgPropose.diff.chip.dissolved"));
          await expect(recordPane).toContainText(t("home.worklist.impact.title"));
          await expect(recordPane).toContainText(t("home.worklist.personCount", { count: 12 }));
          await expect(recordPane).not.toContainText(t("home.inbox.activity.empty"));
          const stripFits = await page
            .locator('[data-deadline-strip] [role="region"]')
            .evaluate(el => el.scrollWidth <= el.clientWidth);
          expect(stripFits).toBe(true);
          const tableFits = await queueTable.evaluate(el => el.scrollWidth <= (el.parentElement?.clientWidth ?? el.clientWidth) + 1);
          expect(tableFits).toBe(true);
          const orgSubjectFits = await queueTable
            .locator('tbody tr[data-id="OC-2026-0418"] [data-card="title"] bdi')
            .first()
            .evaluate(el => el.scrollWidth <= el.clientWidth + 1);
          expect(orgSubjectFits).toBe(true);
        } else {
          const theadBox = await queueTable.locator("thead").boundingBox();
          expect(theadBox ? theadBox.width <= 2 && theadBox.height <= 2 : true).toBe(true);
          const rowHeights = await queueTable.locator("tbody tr[data-id]").evaluateAll(rows =>
            rows.map(r => {
              const rect = r.getBoundingClientRect();
              return { height: Math.round(rect.height), bottom: Math.round(rect.bottom) };
            }),
          );
          expect(rowHeights.every(r => r.height >= 48 && r.height <= 72)).toBe(true);
          expect(rowHeights.filter(r => r.bottom <= 900).length).toBeGreaterThanOrEqual(6);
          const opsTable = worklist.getByRole("table", { name: t("home.worklist.opsTitle"), exact: true });
          const opsFits = await opsTable.evaluate(el => {
            const scroller = el.parentElement;
            return el.scrollWidth <= (scroller?.clientWidth ?? el.clientWidth) + 1 &&
              (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1);
          });
          expect(opsFits).toBe(true);
          await expect(opsTable.locator("..").locator("..").locator("[data-scroll-cue]")).toHaveCount(0);
          await expect(opsTable).toContainText(saeonUniverse.entities[0]!.workplaces[1]!.name);
          await expect(opsTable).toContainText(
            saeonUniverse.worklist.items.find(item => item.id === "att-close-1")!.subject,
          );
          await expect(opsTable).toContainText(
            `${t("accessCodes.domain.bank")} ${t("person.field.notSet")} ${t("home.worklist.personCount", { count: saeonUniverse.payrollRun.missingBankAccountCount })}`,
          );
          for (const openLink of await opsTable.getByRole("link", { name: t("home.inbox.open"), exact: true }).all()) {
            const box = await openLink.boundingBox();
            expect(box && box.x + box.width <= 390).toBe(true);
          }
        }
        await withFullPage(page, () => shot(page, `home--${width}-${theme}`));

        await fits(page, `Console Home ${width} ${theme}`);
        await expectAxe(page, `Console Home ${width} ${theme}`);

        if (width === 390) {
          await queueTable.locator('tbody tr[data-id="OC-2026-0418"]').click();
          await expect(page.locator('aside[data-pane="record"]')).toBeVisible();
          await expect(page.locator("[data-decision-pane]")).toBeVisible();
          await fits(page, `Console Home detail ${width} ${theme}`);
          await expectAxe(page, `Console Home detail ${width} ${theme}`);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console Home filters, 0-match reset, Enter focus, and attention decoupling work end-to-end", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleSaeonWorklist(page);
  try {
    await page.goto("/");
    const worklist = page.locator('[data-pattern="worklist"]');
    const queueTable = worklist.getByRole("grid", { name: t("home.inbox.title"), exact: true });
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);

    await worklist.getByRole("checkbox", { name: t("home.worklist.statutoryOnly"), exact: true }).check();
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(3);
    await worklist.getByRole("checkbox", { name: t("home.worklist.statutoryOnly"), exact: true }).uncheck();
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);

    await worklist.locator("[data-list-find] input").fill("OC-2026-0418");
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(1);

    await worklist.locator("[data-list-find] input").fill("no-such-query-xyz");
    await expect(worklist.getByRole("heading", { name: t("home.worklist.noMatch.title"), exact: true })).toBeVisible();
    await worklist.getByRole("button", { name: t("home.worklist.noMatch.reset"), exact: true }).click();
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(10);

    // Switching attention filter keeps Monthly operations and DeadlineStrip decoupled from the filter.
    const attentionGroup = worklist.getByRole("group", { name: t("home.attention.label"), exact: true });
    await attentionGroup.getByRole("button", { name: new RegExp(`^${t("home.attention.approvals")}`) }).click();
    await expect(queueTable.locator("tbody tr[data-id]")).toHaveCount(2);
    await expect(worklist.getByRole("table", { name: t("home.worklist.opsTitle"), exact: true }).locator("tbody tr")).toHaveCount(2);
    await expect(page.locator("[data-deadline-strip]")).toBeVisible();
    await attentionGroup.getByRole("button", { name: new RegExp(`^${t("home.attention.all")}`) }).click();

    await worklist.getByRole("button", { name: t("home.worklist.columns"), exact: true }).click();
    const colDialog = page.getByRole("dialog", { name: t("home.worklist.columns"), exact: true });
    await expect(colDialog).toBeVisible();
    await colDialog.getByRole("checkbox", { name: t("home.worklist.col.statutory"), exact: true }).uncheck();
    await colDialog.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
    await expect(worklist.getByRole("columnheader", { name: t("home.worklist.col.statutory"), exact: true })).toHaveCount(0);

    const row = queueTable.locator('tbody tr[data-id="OC-2026-0418"]');
    await row.focus();
    await row.press("Enter");
    await expect(page.locator('aside[data-pane="record"]')).toBeVisible();
    await row.focus();
    await row.press("Enter");
    await expect(page.locator('aside[data-pane="record"] h2[tabindex]')).toBeFocused();

    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /inbox renders populated selection and tabs at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupConsoleSaeonWorklist(page, theme);
      try {
        await page.goto("/inbox?sel=OC-2026-0418");
        await expect(page.locator('[data-pattern="worklist"]')).toBeVisible();
        if (width === 1440) {
          await expect(page.getByRole("heading", { level: 1, name: t("home.inbox.title"), exact: true })).toBeVisible();
        }
        await expect(page.locator('aside[data-pane="record"]')).toBeVisible();
        await fits(page, `Console Inbox ${width} ${theme}`);
        await expectAxe(page, `Console Inbox ${width} ${theme}`);

        for (const tab of ["waiting", "reference", "done", "snoozed"] as const) {
          await page.goto(`/inbox?tab=${tab}`);
          await expect(page.locator('[data-pattern="worklist"]')).toBeVisible();
          await expect(page.getByRole("navigation", { name: t("home.lanes"), exact: true })).toBeVisible();
          await fits(page, `Console Inbox tab=${tab} ${width} ${theme}`);
          await expectAxe(page, `Console Inbox tab=${tab} ${width} ${theme}`);
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

for (const path of ["/", "/inbox"] as const) {
  for (const state of ["loading", "empty", "failed", "refused", "setup"] as const) {
    test(`Console ${path} state sweep: ${state} passes layout & WCAG 2.2 AA axe`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await enableConsoleExperience(page, "light");
      const screenState = state === "setup" ? "empty" : state;
      const fixture = await mockScreen(page, screens[0], screenState);
      if (state === "setup") {
        const setupChecklist = { ...homeSetupChecklist("first"), phase: "SETUP" as const };
        await mockRoute(page, "get", "/api/v1/users/me", {
          status: 200,
          json: { ...user, tenant: { name: user.tenant!.name, phase: "SETUP", go_live_at: null } },
        });
        await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: setupChecklist });
        await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", {
          status: 200,
          json: { ...previewData("ready"), blockers: [] },
        });
        await mockRoute(page, "get", "/api/v1/me/action-inbox", {
          status: 200,
          json: { ...inbox(0), setup: setupChecklist },
        });
      }
      try {
        await page.goto(path);
        const worklist = page.locator('[data-pattern="worklist"]');
        if (state === "loading") {
          await expect(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
          await fits(page, `Console ${path} loading`);
          await expectAxe(page, `Console ${path} loading`);
          fixture.release();
          await expect(worklist).toBeVisible();
        } else {
          await expect(worklist).toBeVisible();
          if (state === "empty") {
          await expect(worklist.getByRole("heading", { name: t("home.noWork.title"), exact: true })).toBeVisible();
          await fits(page, `Console ${path} empty`);
          await expectAxe(page, `Console ${path} empty`);
        } else if (state === "failed") {
          await expect(worklist.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({
            timeout: 20_000,
          });
          await fits(page, `Console ${path} failed`);
          await expectAxe(page, `Console ${path} failed`);
        } else if (state === "refused") {
          await expect(
            worklist.getByRole("region", { name: t("common.denied.title.plain"), exact: true }),
          ).toBeVisible();
          await fits(page, `Console ${path} refused`);
          await expectAxe(page, `Console ${path} refused`);
        } else if (state === "setup") {
          if (path === "/") {
            await expect(worklist.getByRole("region", { name: t("setup.title"), exact: true })).toBeVisible();
          } else {
            await expect(worklist.getByRole("heading", { name: t("home.inbox.setup.title"), exact: true })).toBeVisible();
            await expect(worklist.getByRole("navigation", { name: t("home.lanes"), exact: true })).toHaveCount(0);
          }
          await fits(page, `Console ${path} setup`);
          await expectAxe(page, `Console ${path} setup`);
        }
        }
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console decision refusal and step-up flow surface accessible error feedback on / and /inbox", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await setupConsoleSaeonWorklist(page);
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", {
    status: 403,
    json: failure("forbidden"),
  });
  await mockRoute(page, "post", "/api/v1/approvals/{id}/decision", {
    status: 403,
    json: failure("forbidden"),
  });
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", {
    status: 403,
    json: failure("forbidden"),
  });
  try {
    await page.goto("/?sel=OC-2026-0418");
    const decisionPane = page.locator("[data-decision-pane]");
    await expect(decisionPane).toBeVisible();
    await decisionPane.getByRole("button", { name: t("uiWorklist.approve"), exact: true }).click();
    await expect(page.locator('aside[data-pane="record"]').getByRole("alert")).toBeVisible();
    await expectAxe(page, "Console decision refusal /");

    await page.goto("/?sel=leave-app-1");
    await expect(decisionPane).toBeVisible();
    await decisionPane.getByRole("button", { name: t("uiWorklist.approve"), exact: true }).click();
    await expect(page.locator('aside[data-pane="record"]').getByRole("alert")).toBeVisible();
    await expectAxe(page, "Console approval_run decision refusal /");

    await page.goto("/inbox?sel=OC-2026-0418");
    await expect(page.locator("[data-decision-pane]")).toBeVisible();
    await page.locator("[data-decision-pane]").getByRole("button", { name: t("uiWorklist.approve"), exact: true }).click();
    await expect(page.locator('aside[data-pane="record"]').getByRole("alert")).toBeVisible();
    await expectAxe(page, "Console decision refusal /inbox");

    // Step-up passkey prompt on account_security item surfaces step-up failure feedback cleanly.
    const baseInbox = saeonWorklistInbox();
    await mockRoute(page, "get", "/api/v1/me/action-inbox", {
      status: 200,
      json: {
        ...baseInbox,
        items: [
          {
            id: "sec-1",
            kind: "account_security",
            lane: "turn",
            title: t("account.passkey.add"),
            ref: "",
            urg: "wait",
            dueTone: "neutral",
            done: false,
            days_remaining: null,
            links: [{ kind: "account", id: "me" }],
          },
        ],
      },
    });
    await page.goto("/inbox");
    await page.getByRole("button", { name: t("account.passkey.add"), exact: true }).click();
    const stepUpAlert = page.getByRole("main").getByRole("alert");
    await expect(stepUpAlert).toBeVisible();
    await expectAxe(page, "Console step-up refusal /inbox");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console Home English phone (390px) fits PhoneBottomNav overflow and Monthly operations cells cleanly", async ({ page }) => {
  await loadCatalog("en");
  i18n.set("en");
  await page.setViewportSize({ width: 390, height: 900 });
  const unlockExceptionItem: ReturnType<typeof saeonWorklistInbox>["items"][number] = {
    id: `period_unlock:${id(902)}`,
    kind: "period_unlock",
    urg: "now",
    ref: "",
    title: "Kim Doyeon",
    site: "HQ · Payroll",
    due: "2026-11-08T09:00:00+09:00",
    dueTone: "danger",
    days_remaining: -2,
    links: [{ kind: "period_lock", id: id(900) }],
    done: false,
    lane: "turn",
    context: {
      unlock: {
        domain: "payroll",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        requester: "Kim Doyeon",
        reason_code: "RETRO_CORRECTION",
        exceptionId: id(902),
      },
    },
  };
  const { fixture } = await setupConsoleSaeonWorklist(page, "light", "en", [unlockExceptionItem]);
  try {
    await page.goto("/");
    const worklist = page.locator('[data-pattern="worklist"]');
    await expect(worklist).toBeVisible();

    const phoneNav = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
    await expect(phoneNav).toBeVisible();
    // Wait for lazy BarOverflowLinks hydration inside the 5th bottom-nav slot.
    await expect(phoneNav.locator("li > div > button")).toBeVisible();

    const opsTable = worklist.getByRole("table", { name: t("home.worklist.opsTitle"), exact: true });
    await expect(opsTable.locator("tbody tr")).toHaveCount(3);
    await expect(opsTable).toContainText(t("periodLocks.review.title"));
    await expect(opsTable).toContainText(t("uiDeadlineChip.over", { days: 2 }));

    const layout = await page.evaluate(() => {
      const docOverflow = document.documentElement.scrollWidth <= 390;
      const main = document.getElementById("main");
      const mainFits = !!main && main.scrollWidth <= main.clientWidth;
      return { docOverflow, mainFits, docScrollWidth: document.documentElement.scrollWidth };
    });
    expect(layout).toEqual({ docOverflow: true, mainFits: true, docScrollWidth: 390 });

    const opsMetrics = await opsTable.evaluate(table => {
      const rows = [...table.querySelectorAll("tbody tr")];
      return rows.map(row => {
        const tds = [...row.querySelectorAll("td")].filter(td => getComputedStyle(td).display !== "none");
        const tdOverflows = tds.map(td => ({
          scrollWidth: Math.round(td.scrollWidth),
          clientWidth: Math.round(td.clientWidth),
        }));
        const titleEl = row.querySelector<HTMLElement>("strong");
        const titleRect = titleEl?.getBoundingClientRect();
        const titleTdRect = titleEl?.closest("td")?.getBoundingClientRect();
        const dueEl = row.querySelector<HTMLElement>("td:nth-child(4) > div");
        const dueRect = dueEl?.getBoundingClientRect();
        const dueTdRect = dueEl?.closest("td")?.getBoundingClientRect();
        return {
          tdOverflows,
          titleFitsTd:
            !titleEl ||
            !titleRect ||
            !titleTdRect ||
            (titleEl.scrollWidth <= titleEl.clientWidth + 1 && titleRect.right <= titleTdRect.right + 1),
          dueFitsTd:
            !dueEl ||
            !dueRect ||
            !dueTdRect ||
            (dueEl.scrollWidth <= dueEl.clientWidth + 1 && dueRect.right <= dueTdRect.right + 1),
        };
      });
    });
    for (const row of opsMetrics) {
      expect(row.titleFitsTd).toBe(true);
      expect(row.dueFitsTd).toBe(true);
      for (const td of row.tdOverflows) {
        expect(td.scrollWidth).toBeLessThanOrEqual(td.clientWidth + 1);
      }
    }

    await fits(page, "Console Home en 390 light");
    await expectAxe(page, "Console Home en 390 light");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
