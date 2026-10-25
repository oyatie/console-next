// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";
import { gridRow, openItem, panel, queue, rowsGrid, settled } from "../helpers/import-queue";
import { apiOf, bearerOf, codeOf, headcount } from "../helpers/api";
import { addDepartments } from "../structure-flows";

// Import correctness (BE-MIG W02 W03 W12; contract-mig.md) from an empty company, no pay period given: a 고용형태 the
// catalog does not know blocks the apply until answered (null = empty is an answer, then named on the button); a
// near-miss 부서 is offered as a candidate and bound only by the click; known labels are listed as matched; a phone
// never shows in the preview; a 합계 row is no person. The server refuses the apply while the label is open.

const HEAD = ["사번", "성명", "부서", "직위", "입사일", "고용형태", "휴대전화"];
const ROWS = [
  ["CR-01", "가나다", "생산 1팀", "사원", "2020-03-02", "정규직", "010-1234-5678"],
  ["CR-02", "라마바", "생산 1팀", "사원", "2021-04-01", "촉탁", "010-1234-0001"],
  ["CR-03", "사아자", "", "대리", "2019-01-02", "정규직", ""],
  ["합계", "", "", "", "", "", "3명"],
];

test("import correctness: an unknown 고용형태 blocks until answered, a near 부서 binds only on click, no phone shown, no 합계 person", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "migco", "정확상사", false, "정확 본점");
  const api = apiOf(admin, bearerOf(admin));
  // The 부서 on the org chart (trunk's cs-chart; /setup/org redirects there).
  await go(admin, "/org");
  await addDepartments(admin, "정확 본점", ["생산1팀"]);

  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사기록.xlsx", await workbook([{ name: "본사", lines: [HEAD, ...ROWS] }]));
  // No pay period: the roster takes none (both or neither).
  const previewed = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/import/preview"));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const runId = ((await (await previewed).json()) as { run_id: string }).run_id;
  // The phone column is read but never shown; its digits appear nowhere on the page.
  await expect(admin.getByRole("table", { name: "열", exact: true }).getByRole("row").filter({ hasText: "휴대전화" })).toBeVisible();
  await expect(admin.locator("main")).not.toContainText("1234-5678");
  const dryRun = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/dry-run"));
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  const digest = ((await (await dryRun).json()) as { dry_run_digest: string }).dry_run_digest;
  await settled(admin);

  // 정규직 is matched without asking, and said so; 촉탁 is a question that blocks, CONTRACT offered first.
  await expect(await gridRow(queue(admin), "정규직")).toContainText("이름 같음 · 자동");
  await expect(await gridRow(queue(admin), "촉탁")).toContainText("반영 막음");
  await expect(admin.getByRole("button", { name: /^명부 반영/ })).toHaveAttribute("aria-disabled", "true");
  const early = await api(`/employees/import/${runId}/apply`, "POST", { dry_run_digest: digest });
  expect([early.status(), await codeOf(early)]).toEqual([422, "import_unresolved"]);
  expect(await headcount(api)).toBe(0);
  // The 합계 row is no person.
  await expect(rowsGrid(admin)).not.toContainText("합계");

  // 생산 1팀 binds nothing on its own: the candidate is offered, and the people stay 미배치 until it is picked.
  await expect(admin.getByText(/미배치 3명/)).toContainText("찾지 못한 부서 2");
  await openItem(admin, "생산 1팀");
  const near = panel(admin).getByRole("group", { name: /“생산 1팀”와 비슷한 이름/ });
  await expect(near.getByRole("button", { pressed: true })).toHaveCount(0);
  await expectAccessible(admin, "import: candidates and a blocking label");
  await near.getByRole("button", { name: /생산1팀/ }).click();
  await settled(admin);
  // Only the row with no 부서 and no 사업장 stays 미배치, named so.
  await expect(admin.getByText(/미배치 1명/)).toContainText("부서·사업장 없음 1");

  // 촉탁 left empty is an answer: the apply opens and names the people coming in without a type.
  await openItem(admin, "촉탁");
  await panel(admin).getByLabel(/촉탁에 해당하는 고용 형태/).selectOption({ label: "비워 둡니다" });
  await settled(admin);
  await expect(admin.getByText("고용형태 없이 1명")).toBeVisible();
  const apply = admin.getByRole("button", { name: /^명부 반영: 신규 3명/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  expect(await headcount(api)).toBe(3);
  const facets = await (await api("/employees/facets")).json() as { review: { home_branch_review_required: number } };
  expect(facets.review.home_branch_review_required).toBe(1);
  const unplaced = await (await api("/employees/import/unplaced")).json() as { count: number };
  expect(unplaced.count).toBe(1);
  await go(admin, "/people");
  await expect(admin.getByText(/지점 미지정|소속 지점/)).toHaveCount(0);
});
