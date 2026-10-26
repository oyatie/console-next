// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components, paths } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, LONG_NAME } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

type EntityList = paths["/api/v1/legal-entities"]["get"]["responses"][200]["content"]["application/json"];
type S = components["schemas"];
const regular: S["RegularWorkers"] = { status: "HOLD", basis: "LSA_DECREE_7_2", missing: [], live_headcount: 0 };
const states = ["loading", "failed", "refused", "empty-no-entity", "empty-no-workplace", "populated", "long", "large"] as const;

function entities(state: typeof states[number]): EntityList {
  const count = state === "empty-no-entity" ? 0 : state === "large" ? 5 : 2;
  return { items: Array.from({ length: count }, (_, e): S["LegalEntity"] => ({
    id: id(400 + e), needs_confirmation: false, identity_locked: true, founding: false, can_manage: true,
    head_office_has_no_workplace: false, scheduled: [], registrations: [], regular_workers: regular,
    current: { version: 1, effective_from: "2026-01-01", before_first_record: false,
      name: state === "long" ? `${LONG_NAME.repeat(3)} 법인 ${e + 1}` : `검증법인 ${e + 1}`,
      additional_representatives: 0, change_mode: "SETUP" },
    workplaces: Array.from({ length: state === "large" ? 8 : e === 0 ? 2 : 1 }, (_, i): S["Workplace"] => ({
      id: id(500 + e * 10 + i), legal_entity_id: id(400 + e), kind_code: "CUSTOM_KIND", registration_todo: false,
      can_manage: true, is_primary: i === 0, is_head_office: i === 0, needs_confirmation: false, headcount: 0,
      regular_workers: regular, withholding: { kind: "ENTITY_HEAD_OFFICE" },
      closed_on: state === "empty-no-workplace" ? "2026-10-01" : null,
      current: { version: 1, effective_from: "2026-01-01", before_first_record: false,
        name: state === "long" ? `${LONG_NAME.repeat(3)} 사업장 ${e + 1}-${i + 1}` : `검증사업장 ${e + 1}-${i + 1}`,
        is_construction_site: false, status: "CONTINUING", change_mode: "SETUP" },
      insurance: i === 0 ? [{ insurer: "NPS", version: 1, effective_from: "2026-01-01", before_first_record: false,
        status: e === 0 ? "ESTABLISHED_NUMBER_PENDING" : "ESTABLISHED", unit_mode: "OWN" }] : [],
    })),
  })) };
}

test.beforeAll(() => loadCatalog("ko"));

for (const state of states) for (const width of [1440, 390]) {
  test(`workplace bulk: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens.find(s => s.key === "org")!, "populated");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const data = entities(state);
    await mockRoute(page, "get", "/api/v1/legal-entities", async () => {
      requests++;
      if (state === "loading") await held;
      if (state === "failed") return { status: 503, json: failure("service_unavailable") };
      if (state === "refused") return { status: 403, json: failure("forbidden") };
      return { status: 200, json: data };
    });
    await mockRoute(page, "get", "/api/v1/workplace-kinds", { status: 200, json: {
      items: [{ code: "CUSTOM_KIND", label: "맞춤 종류", active: true, platform: false }],
    } });
    try {
      await page.goto("/org/workplaces/edit");
      const main = page.getByRole("main");
      const commit = main.getByRole("button", { name: /\d+곳 일괄 수정/, exact: true });
      const table = main.getByRole("table");
      if (state === "loading") {
        await expect(main.locator('[data-read-layout="list"]')).toBeVisible();
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
        await expect(commit).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
        await expect(main.getByText(fixture.operationId, { exact: true })).toBeVisible();
        await expect(commit).toHaveCount(0);
      } else if (state === "refused") {
        const refusal = main.getByRole("region", { name: t("common.denied.title.plain") });
        await expect(refusal).toBeVisible();
        await expect(refusal.getByRole("button", { name: t("common.denied.request"), exact: true })).toBeVisible();
        await expect(table).toHaveCount(0);
        await expect(commit).toHaveCount(0);
      } else if (state.startsWith("empty")) {
        const noEntity = state === "empty-no-entity";
        await expect(main.getByRole("heading", { name: noEntity ? "등록된 법인이 없습니다" : "열린 사업장이 없습니다" })).toBeVisible();
        const action = main.getByRole("link", { name: noEntity ? "법인 등록" : "사업장 추가", exact: true });
        await expect(action).toBeVisible();
        const href = new URL((await action.getAttribute("href"))!, "http://localhost");
        expect(href.pathname).toBe(noEntity ? "/org/entities/new" : "/org");
        if (!noEntity) {
          expect(href.searchParams.get("sel")).toBe(data.items[0]!.id);
          expect(href.searchParams.get("act")).toBe("wp-create");
        }
        await expect(main.getByRole("button", { name: /일괄 수정/ })).toHaveCount(0);
        await expect(table).toHaveCount(0);
      } else {
        const count = state === "large" ? 40 : 3;
        await expect(table.locator("tbody > tr")).toHaveCount(count);
        await expect(main.getByRole("heading", { name: `사업장 ${count}곳`, exact: true })).toBeVisible();
        await expect(table.getByRole("columnheader")).toHaveCount(5);
        await expect(table).toContainText("맞춤 종류");
        await expect(table).toContainText("번호 입력 전 1건");
        await expect(table).toContainText("성립 1건");
        await expect(commit).toHaveAttribute("aria-disabled", "true");
        await expect(commit).toHaveAccessibleDescription("사업장을 선택하면 일괄 수정할 수 있습니다");
        await commit.click({ force: true });
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const selectAll = table.locator("thead").getByRole("checkbox");
        await selectAll.check();
        await expect(table.locator('tbody input:checked')).toHaveCount(count);
        await expect(commit).toHaveText(`${count}곳 일괄 수정`);
        await table.locator("tbody").getByRole("checkbox").first().uncheck();
        await expect(selectAll).not.toBeChecked();
        await expect(commit).toHaveText(`${count - 1}곳 일괄 수정`);
        await selectAll.check();
        await selectAll.uncheck();
        await expect(table.locator('tbody input:checked')).toHaveCount(0);
        await selectAll.check();
        expect(requests).toBe(1);
        await fits(page, `workplace-bulk/${state}/${width}`);
        await expectAxe(page, `workplace-bulk/${state}/${width}`);
        await commit.click();
        await expect(page.getByRole("dialog", { name: `사업장 ${count}곳 일괄 수정`, exact: true })).toBeVisible();
        await page.getByRole("dialog").getByRole("button", { name: t("orgBulk.cancel"), exact: true }).click();
      }
      await fits(page, `workplace-bulk/${state}/${width}`);
      await expectAxe(page, `workplace-bulk/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      release();
      fixture.release();
    }
  });
}
