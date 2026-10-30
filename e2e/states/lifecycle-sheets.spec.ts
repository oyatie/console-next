// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { AT, id, failure } from "../mock/fixtures";
import { moveDetail, unplacedTarget } from "../mock/lifecycle-sheets";
import { mockRoute } from "../mock/route";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

for (const width of [1440, 390]) {
  for (const state of [403, 503, "loading"] as const) {
    test(`unknown move placement ${state} at ${width}px @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const screen = lifecycleSheetScreens[0];
      const fixture = await mockScreen(page, screen, "populated");
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let structureReads = 0;
      if (state === "loading") {
        await page.route(url => url.pathname === "/api/v1/org-structure", async route => {
          structureReads++;
          await held;
          await route.fulfill({ status: 503, json: failure("service_unavailable") });
        });
      } else {
        await mockRoute(page, "get", "/api/v1/org-structure", { status: state, json: failure(state === 403 ? "forbidden" : "service_unavailable") });
      }
      const previews: string[] = [], writes: string[] = [];
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/lifecycle-case-templates/TRANSFER") previews.push(request.url());
        if (request.method() === "POST" && url.pathname.includes("/lifecycle-events")) writes.push(request.url());
      });
      await page.goto(screen.path);
      if (state === "loading") {
        await expect(page.getByRole("heading", { name: /배치직원/, level: 1 })).toBeVisible();
        await expect.poll(() => structureReads).toBe(1);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(previews).toEqual([]);
        release();
      }
      const sheet = page.getByRole("dialog");
      await expect(sheet).toHaveAccessibleName("발령");
      const picker = sheet.getByRole("combobox", { name: "어디로", exact: true });
      await picker.fill("재무팀");
      await page.getByRole("option", { name: /재무팀/ }).click();
      await sheet.getByRole("button", { name: /^오늘 / }).click();
      await sheet.getByRole("textbox", { name: /^사유/ }).fill("사업장 이동 검토");
      await expect(sheet).toHaveAccessibleName("발령");
      await expect(sheet).not.toContainText(/전보|전근/);
      const commit = sheet.getByRole("button", { name: "발령 1명 적용", exact: true });
      await expect(commit).toHaveAttribute("aria-disabled", "true");
      await expect(commit).toHaveAccessibleDescription("현재 배치와 이동할 사업장을 확인해야 기록할 수 있습니다.");
      await commit.focus();
      await page.keyboard.press("Enter");
      await sheet.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
      await fits(page, `unknown-move/${state}/${width}`);
      await expectAxe(page, `unknown-move/${state}/${width}`);
      expect(previews).toEqual([]);
      expect(writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }

  for (const state of ["null-workplace", "unplaced-target"] as const) {
    test(`known move placement ${state} at ${width}px @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const screen = lifecycleSheetScreens[0];
      const fixture = await mockScreen(page, screen, "populated");
      if (state === "null-workplace") {
        await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: { ...moveDetail, employee: { ...moveDetail.employee, workplace_id: null } } });
      } else {
        await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: unplacedTarget.structure });
        await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [unplacedTarget.entity] } });
      }
      const variants: (string | null)[] = [];
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/lifecycle-case-templates/TRANSFER") variants.push(url.searchParams.get("variant"));
      });
      await page.goto(screen.path);
      const sheet = page.getByRole("dialog");
      const picker = sheet.getByRole("combobox", { name: "어디로", exact: true });
      await picker.fill("재무팀");
      await page.getByRole("option", { name: /재무팀/ }).click();
      await sheet.getByRole("button", { name: /^오늘 / }).click();
      await sheet.getByRole("textbox", { name: /^사유/ }).fill("배치 검토");
      await expect(sheet).toHaveAccessibleName("전보");
      await expect(sheet.getByRole("button", { name: "전보 1명 적용", exact: true })).toBeEnabled();
      await expect(sheet).not.toContainText("전근");
      const siteRow = sheet.getByRole("table", { name: "바뀌는 것" }).locator('[data-id="site"]');
      await expect(siteRow).toHaveText(state === "unplaced-target" ? "사업장본사→ —" : "사업장—→ 부산사업장");
      await expect.poll(() => variants.length).toBeGreaterThan(0);
      expect(variants).not.toContain("WORKPLACE_CHANGE");
      await fits(page, `known-move/${state}/${width}`);
      await expectAxe(page, `known-move/${state}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    });
  }

  test(`move origin and derived kind at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = lifecycleSheetScreens[0];
    const fixture = await mockScreen(page, screen, "populated");
    const variants: (string | null)[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/lifecycle-case-templates/TRANSFER") variants.push(url.searchParams.get("variant"));
    });
    await page.goto(screen.path);
    const sheet = page.getByRole("dialog", { name: "전보", exact: true });
    const picker = sheet.getByRole("combobox", { name: "어디로", exact: true });
    await picker.fill("인사팀");
    await page.getByRole("option", { name: /인사팀/ }).click();
    const changes = page.getByRole("table", { name: "바뀌는 것" });
    await expect(changes.locator('[data-id="unit"]')).toContainText("사업장 직속");
    await expect(changes.locator('[data-id="unit"]')).toContainText("→ 인사팀");
    await expect(changes.locator('[data-id="site"]')).toHaveText("사업장본사→ 본사");
    await expect(sheet.getByRole("button", { name: "전보 1명 예약", exact: true })).toBeVisible();
    expect(variants).not.toContain("WORKPLACE_CHANGE");
    await sheet.getByRole("textbox", { name: /^사유/ }).fill("배치 검토");
    await picker.fill("재무팀");
    await page.getByRole("option", { name: /재무팀/ }).click();
    const relocated = page.getByRole("dialog", { name: "전근", exact: true });
    await expect(relocated).toBeVisible();
    await expect(relocated.getByRole("button", { name: "전근 1명 예약", exact: true })).toBeVisible();
    await expect(changes.locator('[data-id="site"]')).toHaveText("사업장본사→ 부산사업장");
    await expect(relocated).toContainText("전근합니다");
    await expect.poll(() => variants).toContain("WORKPLACE_CHANGE");
    await expect(relocated.getByRole("textbox", { name: /^사유/ })).toHaveValue("배치 검토");
    await fits(page, `move/${width}`);
    await expectAxe(page, `move/${width}`);
    await relocated.getByRole("combobox", { name: "어디로", exact: true }).fill("인사팀");
    await page.getByRole("option", { name: /인사팀/ }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox", { name: /^사유/ })).toHaveValue("배치 검토");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`relocation refusal uses its own name at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = lifecycleSheetScreens[1];
    const fixture = await mockScreen(page, screen, "populated");
    await page.goto(screen.path);
    const menu = page.getByRole("dialog", { name: "발령", exact: true });
    const relocate = menu.getByRole("button", { name: /^전근 / });
    await expect(relocate).toHaveAttribute("aria-disabled", "true");
    await expect(relocate).toContainText("전근은 휴직 중에는 할 수 없습니다.");
    await fits(page, `move-menu/${width}`);
    await expectAxe(page, `move-menu/${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

// Refusal contract: a direct URL must explain why the recorded action cannot open.
test.beforeAll(() => loadCatalog("ko"));
const appliedTransfer: components["schemas"]["EmployeeLifecycleEvent"] = {
  id: id(4050), employee_id: id(4000), event_type: "TRANSFER", state: "APPLIED", to_status: "ACTIVE",
  effective_date: "2026-10-20", comment: "", signoffs: { privacy_notice_ack: true, korean_labor_law_ack: true, payroll_cutoff_ack: false, retirement_settlement_ack: false }, created_by: id(1), created_by_name: "김담당", created_at: AT,
};
for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  for (const [verb, code] of [["correct", "lifecycle_void_not_latest"], ["rescind", "lifecycle_event_voided"]] as const) test(`server refuses ${verb} ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    const event = { ...appliedTransfer, action_refusals: { [verb]: code } };
    await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", { status: 200, json: { items: [event], head_version: 1, next_cursor: null } });
    await page.goto(`/people/${id(4000)}?act=${verb}:${event.id}`);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    const notice = page.getByRole("status").filter({ hasText: t("person.act.unavailable") });
    await expect(notice).toContainText(t(`person.act.unavailable.${code}`));
    await expect(notice.getByText(code, { exact: true })).toBeVisible();
    await fits(page, `server-${verb}/${width}/${theme}`);
    await expectAxe(page, `server-${verb}/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const verb of ["again", "cancel", "edit"]) test(`applied transfer refuses ${verb} ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}/lifecycle-events", { status: 200, json: { items: [appliedTransfer], head_version: 1, next_cursor: null } });
    await page.goto(`/people/${id(4000)}?act=${verb}:${appliedTransfer.id}`);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    const notice = page.getByRole("status").filter({ hasText: t("person.act.unavailable") });
    await expect(notice).toContainText(t("person.act.unavailable.state"));
    await expect(notice.locator("code")).toHaveCount(0);
    await fits(page, `applied-${verb}/${width}/${theme}`);
    await expectAxe(page, `applied-${verb}/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  for (const allowed of [true, false, undefined]) test(`certificate settings refusal ${allowed} ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "post", "/api/v1/hr/certificates", { status: 422, json: failure("certificate_settings_required") });
    const settings = { settings: [], seal_max_bytes: 100000, can_manage: allowed };
    await mockRoute(page, "get", "/api/v1/hr/certificate-settings", { status: 200, json: settings });
    await page.goto(`/people/${id(4000)}?act=cert`);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    const sheet = page.getByRole("dialog", { name: t("empDoc.cert.title"), exact: true });
    await sheet.getByRole("radio", { name: t("empDoc.cert.kind.EMPLOYMENT"), exact: true }).press("Space");
    await sheet.getByRole("checkbox", { name: t("empDoc.cert.item.period"), exact: true }).press("Space");
    await sheet.getByRole("textbox", { name: t("empDoc.certificate.purpose") }).fill("재직 확인");
    await sheet.getByRole("button", { name: t("empDoc.cert.commit"), exact: true }).click();
    const refusal = sheet.getByRole("alert");
    await expect(refusal).toContainText(t("empDoc.certificate.error.certificate_settings_required"));
    const remedy = sheet.getByRole("link", { name: t("empDoc.certificate.settings"), exact: true });
    if (allowed) await expect(remedy).toHaveAttribute("href", `/people/certificates?employee=${id(4000)}#certificate-settings`);
    else await expect(remedy).toHaveCount(0);
    await fits(page, `certificate-refusal/${width}/${theme}`);
    await expectAxe(page, `certificate-refusal/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`reveal verification refusal ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}/rrn", { status: 200, json: { employee_id: id(4000), recorded: true } });
    await mockRoute(page, "get", "/api/v1/reason-codes", request => ({ status: 200, json: { domain: new URL(request.url()).searchParams.get("domain")!, items: [{ code: "IDENTITY_VERIFICATION", label_ko: "본인 확인", label_en: "Identity verification", requires_note: false, system: true, active: true, involuntary: false, notice_required: false }] } }));
    await mockRoute(page, "post", "/api/v1/auth/passkey/step-up/start", { status: 401, json: failure("passkey_step_up_failed") });
    await page.goto(`/people/${id(4000)}`);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await page.getByRole("button", { name: t("empCard.reveal.open", { field: t("empCard.f.rrn") }), exact: true }).click();
    const popover = page.getByRole("dialog");
    await popover.getByRole("radio", { name: t("reason.rrn_reveal.IDENTITY_VERIFICATION"), exact: true }).press("Space");
    await popover.getByRole("button", { name: t("empCard.reveal.primary"), exact: true }).click();
    await expect(popover.getByRole("alert")).toContainText(t("empCard.reveal.error.passkey_step_up_failed"));
    await expect(popover.getByRole("link", { name: t("requestOutcome.open") })).toHaveCount(0);
    await fits(page, `reveal-refusal/${width}/${theme}`);
    await expectAxe(page, `reveal-refusal/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
