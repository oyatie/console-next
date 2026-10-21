// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readDevSecrets } from "../../scripts/dev-secrets";
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, option, registerEmployee, unique } from "../flows";
import { startOperations, tenantInSetup } from "../setup-flows";
import { apiOf, bearerOf, codeOf, headcount } from "../helpers/api";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";
import { settled } from "../helpers/import-queue";
import { letGrantsAge } from "../second-person-fixture";
import { PORTS } from "../slot";

test("J-ONB-19: the applied run opens with file, actor, time and stored counts from recent imports", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "rollbackrecord", "되돌리기테스트", false, "테스트 본점");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "되돌리기명부.xlsx", await workbook([{ name: "명부", lines: [
    ["사번", "성명", "입사일", "고용형태"],
    ["RB-001", "가테스트", "2020-03-02", "정규직"],
    ["RB-002", "나테스트", "2021-04-01", "정규직"],
  ] }]));
  const previewed = admin.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/import/preview"));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const run = ((await (await previewed).json()) as { run_id: string }).run_id;
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await settled(admin);
  await admin.getByRole("button", { name: /^명부 반영: 신규 2명/ }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  const done = admin.getByRole("region", { name: "명부를 반영했습니다" });
  await expect(done.getByRole("heading", { name: "되돌리기명부.xlsx" })).toBeVisible();
  await expect(done.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(done.locator("time")).toContainText(/반영했습니다/);
  await expect(done).toContainText("신규 2명");
  await expectAccessible(admin, "import run record: file, actor, time, counts");

  await admin.getByRole("link", { name: "다른 명부 가져오기" }).click();
  const recent = admin.getByRole("region", { name: "최근 가져오기" });
  const link = recent.getByRole("link", { name: "되돌리기명부.xlsx" });
  await expect(link).toHaveAttribute("href", `/people/import?run=${run}`);
  await expectAccessible(admin, "import recent runs");
  await link.click();
  await expect(done.getByRole("heading", { name: "되돌리기명부.xlsx" })).toBeVisible();
  await expect(done).toContainText("신규 2명");
  const missing = await api(`/employee-import-runs/${crypto.randomUUID()}`);
  expect([missing.status(), await codeOf(missing)]).toEqual([404, "import_run_not_found"]);
  await expect(done).toContainText("신규 2명");
});

async function applyRoster(page: Page, filename: string, lines: string[][]) {
  await go(page, "/people/import");
  await chooseWorkbook(page, filename, await workbook([{ name: "명부", lines }]));
  const previewed = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/import/preview"));
  await page.getByRole("button", { name: "명부 미리보기" }).click();
  const run = ((await (await previewed).json()) as { run_id: string }).run_id;
  await page.getByRole("button", { name: "모의 반영 실행" }).click();
  await settled(page);
  await page.getByRole("button", { name: /^명부 반영: 신규/ }).click();
  await expect(page.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  return run;
}

const rollbackPanel = (page: Page) => page.getByRole("region", { name: "되돌리기", exact: true });
const rosterHeader = ["사번", "성명", "입사일", "고용형태", "직위"];

// Policy is test configuration: there is no tenant settings editor yet. People, accounts, grants and requests use UI.
function routeRollbackPolicy(slug: string) {
  execFileSync("psql", ["-X", "--set", "ON_ERROR_STOP=1", "--set", `slug=${slug}`, "--dbname", "console_dev"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(PORTS.pg), PGUSER: "console_app", PGPASSWORD: readDevSecrets().postgresAppPassword },
    input: `BEGIN;
SELECT set_config('app.current_org', id::text, true) FROM organizations WHERE slug = :'slug';
INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code)
 SELECT o.id, 'approval.policy.import_rollback', '"route"'::jsonb, u.id, 'TEST'
 FROM organizations o JOIN users u ON u.org_id = o.id
 WHERE o.slug = :'slug' AND 'SUPER_ADMIN' = ANY(u.roles);
COMMIT;`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("SETUP rollback acknowledges two new people and one form-record update, then restores the roster", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "rollbacksetup", "되돌림상사", false, "본점");
  const api = apiOf(admin, bearerOf(admin));
  await registerEmployee(admin, { name: "기존직원", number: "RB-FORM", hired: "2020-03-02", unit: "본점", position: "사원" });
  const originalRecord = new URL(admin.url()).pathname;
  expect(await headcount(api)).toBe(1);
  const run = await applyRoster(admin, "설정되돌리기.xlsx", [rosterHeader,
    ["RB-FORM", "기존직원", "2020-03-02", "정규직", "대리"],
    ["RB-NEW1", "가신규", "2021-04-01", "정규직", "사원"],
    ["RB-NEW2", "나신규", "2022-04-01", "정규직", "사원"],
  ]);
  expect(await headcount(api)).toBe(3);
  const panel = rollbackPanel(admin);
  await expect(panel.getByRole("region", { name: "RB-FORM", exact: true })).toContainText(/대리.*사원/);
  const execute = panel.getByRole("button", { name: /^되돌리기(?: 실행)?$/, exact: true });
  await expect(execute).toBeDisabled();
  await expectAccessible(admin, "rollback SETUP inverse preview, light and dark");
  await panel.getByRole("checkbox").press("Space");
  await expect(execute).toBeEnabled();
  await expectAccessible(admin, "rollback SETUP acknowledged, light and dark");
  await execute.click();
  await expect(panel.getByRole("status")).toContainText(/되돌렸습니다/);
  await expectAccessible(admin, "rollback SETUP completed, light and dark");
  expect(await headcount(api)).toBe(1);
  await go(admin, originalRecord);
  await expect(admin.getByRole("heading", { name: "기존직원", level: 1 })).toBeVisible();
  await expect(admin.locator("#f-position")).toContainText("사원");
  await go(admin, "/people/import");
  const recent = admin.getByRole("region", { name: "최근 가져오기" });
  await expect(recent.getByRole("row").filter({ hasText: "설정되돌리기.xlsx" })).toContainText("되돌림");
  const record = recent.getByRole("link", { name: "설정되돌리기.xlsx" });
  await expect(record).toHaveAttribute("href", `/people/import?run=${run}`);
  await record.click();
  await expect(rollbackPanel(admin).getByRole("status")).toContainText(/되돌렸습니다/);
});

test("a later correction blocks every inverse row and a forced rollback writes nothing", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "rollbackblocked", "차단상사", false, "본점");
  const api = apiOf(admin, bearerOf(admin));
  await registerEmployee(admin, { name: "수정직원", number: "RB-EDIT", hired: "2020-03-02", unit: "본점" });
  const record = new URL(admin.url()).pathname;
  await applyRoster(admin, "첫명부.xlsx", [[...rosterHeader, "종사 업무"],
    ["RB-EDIT", "수정직원", "2020-03-02", "정규직", "대리", "설비 관리"],
  ]);
  const run = await applyRoster(admin, "둘째명부.xlsx", [[...rosterHeader, "종사 업무"],
    ["RB-EDIT", "수정직원", "2020-03-02", "정규직", "과장", "품질 관리"],
    ["RB-BLOCKNEW", "차단신규", "2021-04-01", "정규직", "사원", "품질 관리"],
  ]);
  await go(admin, record);
  await admin.getByRole("button", { name: "휴대전화 수정" }).click();
  const phone = admin.getByRole("textbox", { name: "휴대전화" });
  await phone.fill("010-1234-0002");
  await phone.press("Enter");
  await expect(admin.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
  const unrelated = await (await api(`/employee-import-runs/${run}/rollback/preview`, "POST")).json() as { blockers: unknown[] };
  expect(unrelated.blockers, "a later correction of a field this run did not set is preserved").toEqual([]);
  const employee = await (await api(record.replace(/^\/people\//, "/employees/"))).json() as { employee: { id: string; updated_at: string } };
  const corrected = await api(`/employees/${employee.employee.id}`, "PATCH", {
    expected_updated_at: employee.employee.updated_at,
    changes: { job: "생산 관리" }, reason_code: "INPUT_ERROR",
  });
  expect(corrected.status()).toBe(200);
  await go(admin, `/people/import?run=${run}`);
  const panel = rollbackPanel(admin);
  await expect(panel.getByRole("alert")).toContainText("아무것도 되돌리지 않았습니다");
  const blocker = panel.getByRole("table").getByRole("link", { name: "RB-EDIT", exact: true });
  await expect(blocker).toHaveAttribute("href", record);
  await expect(panel.getByRole("button", { name: /^되돌리기(?: 실행)?$/, exact: true })).toBeDisabled();
  await expectAccessible(admin, "rollback blocked by later correction, light and dark");
  const before = await (await api(`/employee-import-runs/${run}`)).json();
  const plan = await (await api(`/employee-import-runs/${run}/rollback/preview`, "POST")).json() as { preview_digest: string };
  const forced = await api(`/employee-import-runs/${run}/rollback`, "POST", {
    preview_digest: plan.preview_digest, acknowledged: true,
  }, { "Idempotency-Key": crypto.randomUUID() });
  expect([forced.status(), await codeOf(forced)]).toEqual([409, "import_rollback_blocked"]);
  expect(await (await api(`/employee-import-runs/${run}`)).json()).toEqual(before);
  expect(await headcount(api)).toBe(2);
});

test("OPERATING rollback waits for another holder and reaches done through the live import frame", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const slug = "rollbackroute";
  const { admin, exec } = await tenantInSetup(browser, slug, "결정상사", false, "본점", "full");
  const api = apiOf(admin, bearerOf(admin));
  await startOperations(admin);
  await go(exec, "/");
  const notice = exec.getByRole("region", { name: "확인할 새 권한 1건" });
  await notice.getByRole("button", { name: "전체 업무 부여 확인 기록" }).click();
  await expect(notice).toBeHidden();
  letGrantsAge(unique(slug), "이임원");
  routeRollbackPolicy(unique(slug));
  const run = await applyRoster(admin, "결정명부.xlsx", [rosterHeader,
    ["RB-ROUTE", "결정직원", "2020-03-02", "정규직", "사원"],
  ]);
  const panel = rollbackPanel(admin);
  await option(admin, "되돌리는 이유", "다른 파일을 올림").click();
  await panel.getByRole("checkbox").press("Space");
  const requested = admin.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/employee-import-runs/${run}/rollback`);
  await panel.getByRole("button", { name: "되돌리기 요청", exact: true }).click();
  const response = await requested;
  expect(response.status()).toBe(202);
  const outcome = await response.json() as { request_id: string };
  await expect(panel.getByRole("status")).toContainText(/다른.*승인/);
  await expect(panel.getByRole("button", { name: /승인|요청 반영/ })).toHaveCount(0);
  await expectAccessible(admin, "rollback pending for requester, light and dark");
  const self = await api(`/change-requests/${outcome.request_id}/decide`, "POST", {
    decision: "APPLY", reason_code: "REVIEWED",
  });
  expect([self.status(), await codeOf(self)]).toEqual([403, "authz_sod_requester"]);
  expect(await headcount(api)).toBe(1);
  await go(exec, "/people/requests?sel=" + outcome.request_id);
  const request = exec.getByRole("complementary", { name: "요청 상세" });
  await expect(request).toContainText("되돌리기");
  await request.getByRole("button", { name: "반영", exact: true }).click();
  await request.getByRole("textbox", { name: /^처리 사유/ }).fill("업로드 파일 확인");
  await expectAccessible(exec, "rollback request second holder decision, light and dark");
  let navigations = 0;
  admin.on("request", r => { if (r.isNavigationRequest()) navigations += 1; });
  await request.getByRole("button", { name: "요청 반영", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(/되돌렸습니다/);
  expect(navigations).toBe(0);
  await expect(admin).toHaveURL(new RegExp(`/people/import\\?run=${run}$`));
  await expectAccessible(admin, "rollback approved live without reload, light and dark");
  expect(await headcount(api)).toBe(0);
});
