// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { go } from "./flows";
import { clearShifts, forgetResize } from "./stability";
import { apiOf, bearerOf } from "./helpers/api";
import { chooseWorkbook } from "./helpers/import";
import { workbook } from "./helpers/import-layouts";
import { settled } from "./helpers/import-queue";
import { registerBranch, REGISTRATION_FIXTURES, tenantInSetup } from "./setup-flows";

const HEAD = ["사번", "성명", "입사일", "고용형태", "사업장"];
async function preview(page: Page, name: string, rows: string[][]) {
  await page.evaluate(clearShifts);
  await go(page, "/people/import");
  await chooseWorkbook(page, name, await workbook([{ name: "명부", lines: [HEAD, ...rows] }]));
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/import/preview"));
  await page.getByRole("button", { name: "명부 미리보기" }).click();
  const read = await response;
  expect(read.ok()).toBe(true);
  return read.json() as Promise<{ run_id: string; sheets_needing_mapping: number }>;
}
async function apply(page: Page) {
  await page.getByRole("button", { name: "모의 반영 실행" }).click();
  await settled(page);
  await page.getByRole("button", { name: /^명부 반영:/ }).click();
  await expect(page.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
}
async function accessibleAtBothWidths(page: Page, surface: string) {
  await expectAccessible(page, `${surface}: desktop`);
  await atPhoneWidth(page, () => expectAccessible(page, `${surface}: phone`));
}

test("placement comes from statutory workplace values; a physical-site reading is asked once and remembered", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "place", "배치상사", false, "본사", "none");
  await registerBranch(admin, "배치상사", "판교지점", REGISTRATION_FIXTURES.branch_primary.brn);
  const api = apiOf(admin, bearerOf(admin));
  await admin.setViewportSize({ width: 1440, height: 900 });
  await forgetResize(admin);
  const rows = Array.from({ length: 11 }, (_, n) => [`PL-${n}`, `배치직원${n}`, "2024-03-04", "정규직", n % 2 ? "판교지점" : "본사"]);
  const first = await preview(admin, "사업장명부.xlsx", rows);
  expect(first.sheets_needing_mapping).toBe(0);
  await expect(admin.getByRole("button", { name: "근무지(고객 현장)로 읽기" })).toHaveCount(0);
  await accessibleAtBothWidths(admin, "workplace import preview");
  await apply(admin);
  const people = await (await api("/employees?limit=100")).json() as { items: { id: string; name: string; workplace_id: string | null }[] };
  expect(people.items).toHaveLength(11);
  expect(people.items.every((p) => p.workplace_id)).toBe(true);
  const facets = await (await api("/employees/facets")).json() as { review: { home_branch_review_required: number } };
  expect(facets.review.home_branch_review_required).toBe(0);
  const empty = await (await api("/employees/import/unplaced")).json() as { count: number };
  expect(empty.count).toBe(0);
  await go(admin, "/people");
  await expect(admin.getByText(/지점 미지정|소속 지점/)).toHaveCount(0);
  await expect(admin.getByRole("row").filter({ hasText: "배치직원0" })).toContainText("본사 · 사업장 직속");
  await expect(admin.getByRole("row").filter({ hasText: "배치직원1" }).first()).toContainText("판교지점 · 사업장 직속");
  const placedRows = admin.getByRole("row").filter({ hasText: "배치직원" });
  for (const row of await placedRows.all()) await expect(row).not.toContainText("미배치");
  await accessibleAtBothWidths(admin, "placed roster");
  for (const person of people.items) {
    await admin.evaluate(clearShifts);
    await go(admin, `/people/${person.id}`);
    const place = admin.getByRole("group", { name: "소속", exact: true });
    await expect(place).toContainText("배치상사");
    await expect(place).toContainText(Number(person.name.replace("배치직원", "")) % 2 ? "판교지점" : "본사");
    await expect(admin.getByText("소속 지점", { exact: true })).toHaveCount(0);
    await expect(admin.getByRole("button", { name: /소속 지점 지정/ })).toHaveCount(0);
  }
  await accessibleAtBothWidths(admin, "placed personnel card");
  const selected = people.items[0]!;
  await go(admin, `/people?sel=${selected.id}`);
  const peek = admin.getByRole("complementary", { name: "직원 상세" });
  await expect(peek).toContainText("배치상사");
  await expect(peek).not.toContainText("소속 지점");

  const sites = [["SITE-1", "현장직원", "2024-03-04", "정규직", "고객가 현장"]];
  const ambiguous = await preview(admin, "고객현장.xlsx", sites);
  expect(ambiguous.sheets_needing_mapping).toBe(1);
  await expect(admin.getByRole("button", { name: "법인 사업장으로 읽기" })).toBeVisible();
  const reread = admin.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/import/preview"));
  await admin.getByRole("button", { name: "근무지(고객 현장)로 읽기" }).click();
  expect((await (await reread).json() as { sheets_needing_mapping: number }).sheets_needing_mapping).toBe(0);
  await apply(admin);
  const sitePeople = await (await api("/employees?search=" + encodeURIComponent("현장직원"))).json() as { items: { id: string; workplace_id: string | null; worksite_name: string | null }[] };
  expect(sitePeople.items).toHaveLength(1);
  expect(sitePeople.items[0]).toMatchObject({ workplace_id: null, worksite_name: "고객가 현장" });
  await admin.evaluate(clearShifts);
  await go(admin, `/people/${sitePeople.items[0]!.id}`);
  await expect(admin.getByRole("group", { name: "소속", exact: true })).not.toContainText("고객가 현장");
  await accessibleAtBothWidths(admin, "unplaced personnel card");
  await go(admin, "/people");
  // The roster offers the unplaced queue as one link (its count lives on the queue page).
  await expect(admin.getByRole("main").getByRole("link", { name: "미배치", exact: true })).toHaveAttribute("href", "/people/unplaced");
  await go(admin, "/people/unplaced");
  await expect(admin.getByRole("row").filter({ hasText: "현장직원" })).toBeVisible();
  await expect(admin.getByRole("row").filter({ hasText: "배치직원" })).toHaveCount(0);
  await admin.evaluate(clearShifts);
  await go(admin, "/");
  await expect(admin.getByText("사업장 없음", { exact: true })).toBeVisible();
  await expect(admin.getByRole("listitem").filter({ hasNot: admin.getByRole("list") }).filter({ hasText: "현장직원" }).getByRole("link", { name: "배치", exact: true })).toHaveAttribute("href", `/people/${sitePeople.items[0]!.id}?act=TRANSFER`);
  await accessibleAtBothWidths(admin, "placement follow-up on Home");
  const remembered = await preview(admin, "같은현장다시.xlsx", sites);
  expect(remembered.sheets_needing_mapping).toBe(0);
  await expect(admin.getByRole("button", { name: "근무지(고객 현장)로 읽기" })).toHaveCount(0);
  // Setup must restore the original placement history, rather than starting it on the repair date.
  const employeeId = sitePeople.items[0]!.id;
  await go(admin, "/people/unplaced");
  await admin.getByRole("button", { name: "1명 모두 선택" }).click();
  await admin.getByRole("combobox", { name: "둘 부서" }).fill("본사");
  await admin.getByRole("option", { name: /› 본사 \d+명$/ }).click();
  await admin.getByRole("button", { name: "선택한 부서에 배치" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1명 배치 끝" })).toBeVisible({ timeout: 30_000 });
  const assignments = await (await api(`/employment-assignments?employee_id=${employeeId}`)).json() as { items: { valid_from: string; workplace_id: string | null }[] };
  expect(assignments.items).toEqual([expect.objectContaining({ valid_from: sites[0]![2], workplace_id: expect.any(String) })]);
});
