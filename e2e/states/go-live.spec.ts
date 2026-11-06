// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { GoLivePreview } from "@console/api/pending";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, screenAccess, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { homeSetupChecklist, homeSetupScreen } from "./home-setup";

const states = ["loading", "failed", "refused", "blocked", "ready", "receipt", "legacy-receipt", "missing-receipt", "unknown-receipt"] as const;

function previewData(state: (typeof states)[number]): GoLivePreview {
  const isReceipt = state.endsWith("receipt");
  const records = state === "blocked"
    ? Array.from({ length: 2000 }, (_, i) => ({ kind: "employee", id: id(1000 + i), name: `부서지정대상 ${String(i + 1).padStart(4, "0")}`, legal_entity_id: id(10) }))
    : [];
  const breakdown = Array.from({ length: 20 }, (_, i) => ({
    kind: i === 0 ? "legal_entity" as const : "workplace" as const,
    id: id(50 + i), legal_entity_id: id(10), name: i === 0 ? "검증법인" : `검증사업장 ${i}`, people: 100, units: 3,
  }));
  return {
    phase: isReceipt ? "OPERATING" : "SETUP", digest: `digest-${state}`, line_digests: {}, terms_version: null,
    blockers: isReceipt ? [{ code: "already_operating", count: null, remedy: null, records: [] }] : state === "blocked" ? [{ code: "people_without_department", count: records.length, remedy: "assign_department", records }] : [],
    warnings: isReceipt ? [] : [{ code: "sole_holder", count: 1, remedy: null, records: [] }],
    becomes_governed: ["setup_undo_becomes_correction", "entity_identifier_corrections_locked", "org_structure_changes_need_approval"],
    breakdown,
    roles_becoming_active: [{ role_id: id(80), role: "인사 담당", scope_kind: "TENANT", scope_id: id(2), scope: "전체", holders: [{ id: id(1), name: "김담당" }] }],
    access_admin_holders: [{ id: id(1), name: "김담당" }],
    hr_accounts_with_no_grant: [],
    facts: {
      phase_is_setup: !isReceipt, terms_accepted: true, org_step_skipped: false,
      security_contact_recorded: true, security_contact_store_available: true, employees_step_deferred: false,
      entities_needing_confirmation: 0, registrations: 1, registrations_needing_confirmation: 0,
      registrations_unverified: 0, entities_without_primary_workplace: 0, workplaces_incomplete: 0,
      org_change_approvers: 1, other_eligible_holders: 0, org_change_routed: true,
      unmapped_assignments: 0, insurance_not_established_with_people: 0, insurance_numbers_pending: 0,
      org_changes_in_approval: 0, own_passkeys: 2, unplaced_people: 0, entity_unknown_people: 0,
      tenant_roles: 1, non_ops_grants: 0, access_admin_holders: 1, roles_step_skipped: false,
      entities: 1, workplaces: 19, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0,
      org_units: 60, employees: 2000, employees_starting_later: 0, setup_writes: 12,
      prepared_grants: 1, grants_effective_in_setup: 0, hr_accounts_invited: 1, hr_accounts_enrolled: 1,
    },
  };
}

for (const locale of ["ko", "en"] as const) for (const width of [1440, 390]) {
  test(`go-live: failed refresh recovers in ${locale} at ${width}px @ui-state`, async ({ page }, info) => {
    await loadCatalog(locale);
    i18n.set(locale);
    const text = t;
    await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
    info.annotations.push({ type: "registry", description: "setup-go-live--load-failed-common-loadfailed-retry-operationid" });
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, homeSetupScreen, "empty");
    const preview = previewData("ready");
    preview.blockers = [{ code: "terms_not_accepted", count: null, remedy: "accept_terms", records: [] }];
    let accepted = false;
    let recover = false;
    let writes = 0;
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true, tenant: { name: "화면 검증 회사", phase: "SETUP", go_live_at: null } } });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/setup/go-live", "SETUP"), is_ops: true } });
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", () => accepted && !recover
      ? { status: 503, json: failure("service_unavailable") }
      : { status: 200, json: { ...preview, blockers: accepted ? [] : preview.blockers } });
    const terms = { version: "2026-10-01", sha256: "a".repeat(64), body: "서비스 이용약관" };
    await mockRoute(page, "get", "/api/v1/onboarding/terms", { status: 200, json: { ...terms, privacy: { ...terms, policy_url: "https://example.test/privacy", review_pending: false } } });
    await page.route("**/api/v1/onboarding/terms", route => {
      if (route.request().method() !== "POST") return route.fallback();
      accepted = true;
      return route.fulfill({ status: 204 });
    });
    await mockRoute(page, "post", "/api/v1/onboarding/go-live", () => { writes++; return { status: 503, json: failure("service_unavailable") }; });
    try {
      await page.goto("/setup/go-live");
      const main = page.getByRole("main");
      const start = main.getByRole("button", { name: text("setup.golive.start"), exact: true });
      const ack = main.getByRole("checkbox", { name: text("setup.golive.soleHolder"), exact: true });
      await ack.check();
      await main.getByRole("button", { name: text("setup.terms.read"), exact: true }).click();
      await main.getByRole("button", { name: text("setup.terms.accept"), exact: true }).click();
      const retry = main.getByRole("button", { name: text("common.retry"), exact: true });
      await expect(retry).toBeVisible({ timeout: 20_000 });
      await expect(start).toHaveAttribute("aria-disabled", "true");
      await expect(start).toHaveAccessibleDescription(locale === "ko" ? "미리보기를 새로 읽지 못했습니다. 다시 시도한 뒤 운영을 시작하십시오" : "The preview could not be refreshed. Retry before starting operations");
      await expect(ack).toBeChecked();
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `go-live/refresh-failed/${locale}/${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`refresh-failed-${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `go-live/refresh-failed/${locale}/${width}`);
      recover = true;
      await retry.click();
      await expect(start).not.toHaveAttribute("aria-disabled", "true");
      await expect(ack).toBeChecked();
      await expect(retry).toHaveCount(0);
      expect(writes).toBe(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test.beforeAll(() => loadCatalog("ko"));
test.beforeEach(() => i18n.set("ko"));

for (const state of states) for (const width of [1440, 390]) {
  test(`go-live: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, homeSetupScreen, "empty");
    const isReceipt = state.endsWith("receipt");
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: {
      ...user, is_tenant_ops: true, tenant: { name: "화면 검증 회사", phase: isReceipt ? "OPERATING" : "SETUP", go_live_at: isReceipt ? "2026-10-26T09:00:00Z" : null },
    } });
    await mockRoute(page, "get", "/api/v1/access/me", () => ({
      status: 200, json: { ...screenAccess("/setup/go-live", isReceipt ? "OPERATING" : "SETUP"), is_ops: true },
    }));
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/receipt", () => {
      if (state === "missing-receipt") return { status: 404, json: failure("go_live_receipt_not_found") };
      return { status: 200, json: {
        go_live_at: "2026-10-25T09:00:00Z", go_live_by: id(1), preview_digest: "a".repeat(64),
        facts_snapshot_version: state === "unknown-receipt" ? 2 : 1,
        facts_snapshot: state === "legacy-receipt" ? null : { ...previewData("ready").facts, entities: 7, employees: 42 },
      } };
    });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: homeSetupChecklist("all-done") });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", async () => {
      if (state === "loading") await held;
      if (state === "failed") return { status: 503, json: failure("service_unavailable") };
      if (state === "refused") return { status: 403, json: failure("forbidden") };
      return { status: 200, json: previewData(state) };
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto("/setup/go-live");
      const main = page.getByRole("main");
      const start = main.getByRole("button", { name: t("setup.golive.start"), exact: true });
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible({ timeout: 20_000 });
        await expect(start).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
        await expect(start).toHaveCount(0);
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
        await expect(start).toHaveCount(0);
      } else if (state === "missing-receipt") {
        await expect(main.getByText(t("setup.error.go_live_receipt_not_found"), { exact: true })).toBeVisible();
        await expect(main.getByText(t("setup.receipt.started.title"), { exact: true })).toHaveCount(0);
        await expect(start).toHaveCount(0);
      } else if (state.endsWith("receipt")) {
        await expect(main.getByText(t("setup.receipt.started.title"), { exact: true })).toBeVisible();
        await expect(main.getByText("digest-receipt", { exact: true })).toHaveCount(0);
        await expect(main.getByRole("link", { name: t("setup.bulk.history"), exact: true })).toHaveAttribute("href", "/org/history");
        await expect(main.getByText(t("setup.golive.item.already_operating"), { exact: true })).toHaveCount(0);
        await expect(start).toHaveCount(0);
        await expect(main.getByRole("heading", { name: t(state === "legacy-receipt" ? "setup.receipt.unrecorded" : state === "unknown-receipt" ? "setup.receipt.unsupported" : "setup.receipt.recorded"), exact: true })).toBeVisible();
        if (state === "legacy-receipt" || state === "unknown-receipt") {
          await expect(main.getByText(t(state === "legacy-receipt" ? "setup.receipt.unrecorded" : "setup.receipt.unsupported"), { exact: true })).toBeVisible();
        } else {
          const recorded = main.getByRole("region", { name: t("setup.receipt.recorded"), exact: true });
          await expect(recorded.getByText("42", { exact: true })).toBeVisible();
          await expect(recorded.getByText("2,000", { exact: true })).toHaveCount(0);
          await expect(recorded.locator("time")).toHaveAttribute("datetime", "2026-10-25T09:00:00Z");
        }
        for (const theme of ["light", "dark"]) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          await fits(page, `go-live/${state}/${width}/${theme}`);
          await page.screenshot({ path: test.info().outputPath(`${state}-${width}-${theme}.png`), fullPage: true });
          await expectAxe(page, `go-live/${state}/${width}/${theme}`);
        }
      } else {
        const back = main.getByRole("link", { name: t("common.back"), exact: true });
        const ack = main.getByRole("checkbox", { name: t("setup.golive.soleHolder"), exact: true });
        await expect(start).toBeVisible();
        await expect(back).toBeVisible();
        await expect(ack).toBeVisible();
        expect(await main.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        expect(await main.evaluate(el => el.scrollTop)).toBe(0);
        const [startBox, backBox] = await Promise.all([start.boundingBox(), back.boundingBox()]);
        expect(startBox!.y).toBeGreaterThanOrEqual(0);
        expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(900);
        expect(backBox!.y + backBox!.height).toBeLessThanOrEqual(900);
        if (width === 1440) {
          expect(Math.abs(startBox!.y - backBox!.y)).toBeLessThanOrEqual(4);
          expect(startBox!.x).toBeGreaterThan(backBox!.x + backBox!.width);
        }
        await expect(start).toHaveAttribute("aria-disabled", "true");
        if (state === "ready") {
          await expect(start).toHaveAccessibleDescription(t("setup.golive.ackNeeded"));
          await ack.check();
          await expect(start).not.toHaveAttribute("aria-disabled", "true");
        } else {
          await expect(start).toHaveAccessibleDescription(t("setup.golive.blocked", { count: 1 }));
          await expect(main.getByText(t("uiBlocker.who"), { exact: true })).toHaveCount(0);
        }
        for (const theme of ["light", "dark"]) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          await fits(page, `go-live/${state}/${width}/${theme}`);
          await expectAxe(page, `go-live/${state}/${width}/${theme}`);
        }
      }
      await fits(page, `go-live/${state}/${width}`);
      await expectAxe(page, `go-live/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      release();
      fixture.release();
    }
  });
}
