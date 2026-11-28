// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { setupConsoleSaeonPeople } from "./people-saeon";
import { mockRoute } from "./route";
import { failure, id } from "./fixtures";
import { SAEON_HERO_ID, saeonAdminUser, saeonUniverse } from "./saeon";

test.beforeAll(() => loadCatalog("ko"));

const capture = async (page: Page, width: 1440 | 390, name: string, theme: "light" | "dark") => {
  if (!process.env.STRUCT_SHOTS) return;
  await withFullPage(page, () => shot(page, `${name}--${width}-${theme}`));
};

const MASKED_HERO_PHONE = "010-\u2022\u2022\u2022\u2022-4821";

function saeonRequests() {
  const admin = saeonAdminUser();
  const peers = saeonUniverse.rosterWindow;
  const siteName = saeonUniverse.entities[0]!.workplaces[0]!.name;
  return [
    {
      id: id(701),
      kind: "PROFILE_CORRECTION" as const,
      subject_type: "EMPLOYEE" as const,
      subject_id: SAEON_HERO_ID,
      subject_name: saeonUniverse.hero.name,
      subject_number: saeonUniverse.hero.employeeNumber,
      payload: { changes: { phone: MASKED_HERO_PHONE } },
      reason_code: "DATA_ENTRY_ERROR",
      note: saeonUniverse.requestNotes.phoneCorrection,
      status: "OPEN" as const,
      assignee_role: "HR" as const,
      review_required: false,
      requested_by: "other-requester",
      assignee_user_id: admin.id,
      can_review: true,
      created_at: "2026-11-10T08:30:00Z",
      decided_at: null,
      decision_reason_code: null,
      decision_note: null,
    },
    {
      id: id(702),
      kind: "OTHER" as const,
      subject_type: "EMPLOYEE" as const,
      subject_id: id(202),
      subject_name: peers[0]?.name ?? "Peer One",
      subject_number: peers[0]?.employeeNumber ?? "10612",
      payload: {},
      reason_code: "SCOPE_ADJUSTMENT",
      note: saeonUniverse.requestNotes.workplaceReview,
      status: "OPEN" as const,
      assignee_role: "HR" as const,
      review_required: true,
      requested_by: "other-requester",
      assignee_user_id: null,
      created_at: "2026-11-10T07:15:00Z",
      decided_at: null,
      decision_reason_code: null,
      decision_note: null,
    },
    {
      id: id(703),
      kind: "ACCESS_REQUEST" as const,
      subject_type: "USER_ACCOUNT" as const,
      subject_id: admin.id,
      subject_name: saeonUniverse.adminActor.name,
      subject_number: null,
      payload: {},
      reason_code: "NEW_ASSIGNMENT",
      note: null,
      status: "OPEN" as const,
      assignee_role: "HR" as const,
      review_required: false,
      requested_by: admin.id,
      assignee_user_id: null,
      created_at: "2026-11-09T16:20:00Z",
      decided_at: null,
      decision_reason_code: null,
      decision_note: null,
    },
    {
      id: id(704),
      kind: "IDENTITY_REVIEW" as const,
      subject_type: "EMPLOYEE" as const,
      subject_id: id(204),
      subject_name: peers[1]?.name ?? "Peer Two",
      subject_number: peers[1]?.employeeNumber ?? "10618",
      payload: {},
      reason_code: "DUPLICATE_CHECK",
      note: null,
      status: "OPEN" as const,
      assignee_role: "HR" as const,
      review_required: false,
      requested_by: "other-requester",
      assignee_user_id: null,
      created_at: "2026-11-09T14:10:00Z",
      decided_at: null,
      decision_reason_code: null,
      decision_note: null,
    },
    {
      id: id(705),
      kind: "POLICY_QUESTION" as const,
      subject_type: "BRANCH" as const,
      subject_id: id(205),
      subject_name: siteName,
      subject_number: null,
      payload: {},
      reason_code: "SHIFT_POLICY",
      note: null,
      status: "OPEN" as const,
      assignee_role: "HR" as const,
      review_required: false,
      requested_by: "other-requester",
      assignee_user_id: null,
      created_at: "2026-11-09T11:05:00Z",
      decided_at: null,
      decision_reason_code: null,
      decision_note: null,
    },
    {
      id: id(706),
      kind: "PROFILE_CORRECTION" as const,
      subject_type: "EMPLOYEE" as const,
      subject_id: id(206),
      subject_name: peers[2]?.name ?? "Peer Three",
      subject_number: peers[2]?.employeeNumber ?? "10625",
      payload: { changes: { name: peers[2]?.name ?? "Peer Three" } },
      reason_code: "DATA_ENTRY_ERROR",
      note: null,
      status: "OPEN" as const,
      assignee_role: "HR" as const,
      review_required: false,
      requested_by: "other-requester",
      assignee_user_id: null,
      created_at: "2026-11-08T17:45:00Z",
      decided_at: null,
      decision_reason_code: null,
      decision_note: null,
    },
  ];
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /people/requests renders P2 ListRecord with single counts read at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await setupConsoleSaeonPeople(page, { theme });
      const items = saeonRequests();
      const listReads: URLSearchParams[] = [];
      const countReads: URLSearchParams[] = [];
      const employeeDetailCalls: string[] = [];
      page.on("request", req => {
        const pathname = new URL(req.url()).pathname;
        if (/^\/api\/v1\/employees\/[^/]+$/.test(pathname)) employeeDetailCalls.push(pathname);
      });
      await mockRoute(page, "get", "/api/v1/change-requests/counts", req => {
        countReads.push(new URL(req.url()).searchParams);
        return { status: 200, json: { all: items.length, me: 1, role: 5 } };
      });
      await mockRoute(page, "get", "/api/v1/change-requests", req => {
        const query = new URL(req.url()).searchParams;
        listReads.push(query);
        return { status: 200, json: { items, total: items.length, limit: 20, offset: 0 } };
      });
      await mockRoute(page, "post", "/api/v1/change-requests/{id}/decide", req => {
        const reqId = req.url().split("/").at(-2)!;
        const target = items.find(x => x.id === reqId) ?? items[0]!;
        return { status: 200, json: { ...target, status: "APPLIED" as const, decided_at: "2026-11-10T09:30:00Z", decision_reason_code: saeonUniverse.requestNotes.hrVerified } };
      });

      try {
        await page.goto(width === 1440 ? `/people/requests?sel=${items[0]!.id}` : "/people/requests");
        const pattern = page.locator('[data-pattern="list-record"]');
        await expect(pattern).toBeVisible();
        await expect(page.getByRole("main").locator("h1")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1, name: t("requests.title"), exact: true })).toBeVisible();
        await expect.poll(() => listReads.length).toBe(1);
        await expect.poll(() => countReads.length).toBe(1);
        expect(employeeDetailCalls).toEqual([]);

        const rows = pattern.locator("tbody tr[data-id]");
        await expect(rows).toHaveCount(items.length);
        await expect(pattern).toContainText(`${saeonUniverse.hero.name} (${saeonUniverse.hero.employeeNumber})`);
        await expect(pattern).toContainText(`${t("requests.subject.USER_ACCOUNT")} · ${saeonUniverse.adminActor.name}`);
        for (const code of ["DATA_ENTRY_ERROR", "SCOPE_ADJUSTMENT", "NEW_ASSIGNMENT", "DUPLICATE_CHECK", "SHIFT_POLICY"] as const) {
          await expect(pattern).not.toContainText(code);
        }
        await expect(pattern).toContainText(t("requests.reason.DATA_ENTRY_ERROR"));

        const bottomBar = width === 390
          ? page.getByRole("navigation", { name: t("shell.nav"), exact: true })
          : page.getByRole("contentinfo", { name: t("shell.status.label"), exact: true });
        await expect(bottomBar).toBeInViewport({ ratio: 1 });
        const barBox = await bottomBar.boundingBox();
        expect(barBox).not.toBeNull();
        expect(Math.abs(barBox!.y + barBox!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);

        if (width === 1440) {
          const sidePane = page.locator('aside[data-pane="record"]');
          await expect(sidePane).toBeVisible();
          await expect(sidePane).toContainText(MASKED_HERO_PHONE);
          const gridBox = await pattern.locator('[role="grid"]').boundingBox();
          const sideBox = await sidePane.boundingBox();
          expect(gridBox).not.toBeNull();
          expect(sideBox).not.toBeNull();
          expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(sideBox!.x + 1);
          await capture(page, width, "people-requests", theme);

          await sidePane.getByRole("button", { name: t("requests.decide.APPLY"), exact: true }).click();
          await sidePane.getByRole("textbox", { name: t("requests.decision.reason") }).fill(saeonUniverse.requestNotes.hrVerified);
          await sidePane.getByRole("button", { name: t("requests.commit.APPLY"), exact: true }).click();
          await expect(pattern.getByRole("status")).toContainText(t("requests.done.APPLIED", { kind: t("requests.kind.PROFILE_CORRECTION") }));
          await expect.poll(() => countReads.length).toBeGreaterThanOrEqual(2);
        } else {
          let aboveFold = 0;
          for (let i = 0; i < items.length; i++) {
            const box = await rows.nth(i).boundingBox();
            expect(box).not.toBeNull();
            expect(box!.height).toBeGreaterThanOrEqual(48);
            expect(box!.height).toBeLessThanOrEqual(72);
            if (box!.y + box!.height <= barBox!.y) aboveFold += 1;
          }
          expect(aboveFold).toBeGreaterThanOrEqual(6);
          await capture(page, width, "people-requests", theme);

          await rows.first().getByRole("button", { name: t("requests.open"), exact: true }).click();
          const sheet = page.locator('aside[data-pane="record"]');
          await expect(sheet).toBeVisible();
          await expect(sheet).toContainText(MASKED_HERO_PHONE);
        }

        await fits(page, `Console /people/requests ${width} ${theme}`);
        await expectAxe(page, `Console /people/requests ${width} ${theme}`);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console /people/requests handles 403 refusal and preserves baseline experience", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const refused = await setupConsoleSaeonPeople(page, { experience: "console" });
  await mockRoute(page, "get", "/api/v1/change-requests", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "get", "/api/v1/change-requests/counts", { status: 403, json: failure("forbidden") });
  try {
    await page.goto("/people/requests");
    await expect(page.getByRole("main").getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await expect(page.locator('aside[data-pane="record"]')).toHaveCount(0);
    expect(refused.unexpected).toEqual([]);
  } finally {
    refused.release();
  }

  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const baseline = await setupConsoleSaeonPeople(page, { experience: "baseline" });
  await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [], total: 0, limit: 20, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/change-requests/counts", { status: 200, json: { all: 0, me: 0, role: 0 } });
  try {
    await page.goto("/people/requests");
    await expect(page.locator('[data-pattern="list-record"]')).toHaveCount(0);
    await expect(page.locator("section.card")).toBeVisible();
    expect(baseline.unexpected).toEqual([]);
  } finally {
    await page.close();
    baseline.release();
  }
});

for (const experience of ["baseline", "console"] as const) {
  test(`direct request selection survives page and status filters in ${experience}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await setupConsoleSaeonPeople(page, { experience });
    const [target,other] = saeonRequests();
    const selectedNote = "Selection proof for an off-page request";
    const offPage = { ...target!, note: selectedNote };
    const reads: URLSearchParams[] = [];
    await mockRoute(page, "get", "/api/v1/change-requests", req => {
      const query = new URL(req.url()).searchParams;
      reads.push(query);
      if (query.has("id")) return { status: 200, json: { items: [offPage], total: 1, limit: 1, offset: 0 } };
      if (query.get("status") === "DECLINED") return { status: 200, json: { items: [], total: 0, limit: 20, offset: 0 } };
      const offset = Number(query.get("offset") ?? 0);
      return { status: 200, json: { items: offset === 20 ? [offPage] : [other!], total: 21, limit: 20, offset } };
    });
    try {
      await page.goto(`/people/requests?sel=${offPage.id}`);
      await expect(page.getByText(selectedNote, { exact: true })).toBeVisible();
      expect(reads.some(q => q.get("offset") === "0" && q.get("status") === "OPEN")).toBe(true);
      const exact = reads.find(q => q.has("id"))!;
      expect(Object.fromEntries(exact)).toEqual({ id: offPage.id, limit: "1" });
      await page.goto(`/people/requests?status=DECLINED&sel=${offPage.id}`);
      await expect(page.getByText(selectedNote, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: t("requests.none.title") })).toBeVisible();
      reads.length = 0;
      await page.goto(`/people/requests?page=1&sel=${offPage.id}`);
      await expect(page.getByText(selectedNote, { exact: true })).toBeVisible();
      expect(reads.some(q => q.get("offset") === "20")).toBe(true);
      expect(reads.some(q => q.has("id"))).toBe(false);
      await page.getByRole("button", { name: t("requests.panel.close"), exact: true }).click();
      await expect(page).toHaveURL(/page=1/);
      await expect(page).not.toHaveURL(/sel=/);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`direct request selection distinguishes retry, unavailable and denied states in ${experience}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await setupConsoleSaeonPeople(page, { experience });
    let outcome: "unavailable" | "failed" | "denied" = "failed";
    await mockRoute(page, "get", "/api/v1/change-requests", req => {
      const query = new URL(req.url()).searchParams;
      if (query.has("id") && outcome === "failed") return { status: 503, json: failure("service_unavailable") };
      if (query.has("id") && outcome === "denied") return { status: 403, json: failure("forbidden") };
      return { status: 200, json: { items: [], total: 0, limit: query.has("id") ? 1 : 20, offset: 0 } };
    });
    try {
      await page.goto(`/people/requests?sel=${id(902)}`);
      await expect(page.getByRole("heading", { name: t("common.loadFailed.title") })).toBeVisible();
      outcome = "unavailable";
      await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(page.getByRole("heading", { name: t("common.read.notFound.title") })).toBeVisible();
      outcome = "denied";
      await page.goto(`/people/requests?sel=${id(903)}`);
      await expect(page.getByText(t("common.read.notFound.title"), { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: t("requests.panel.close"), exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: t("common.denied.panel"), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
