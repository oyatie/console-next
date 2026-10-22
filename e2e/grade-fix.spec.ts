import { expect, test } from "@playwright/test";
import { soloTenant } from "./chaos";
import { go, option, registerEmployee } from "./flows";
import { statement } from "./sheet";
import { setupCompany, startOperations } from "./setup-flows";
import { apiOf, bearerOf } from "./helpers/api";
import { gradeJourney, openGradeFix } from "./helpers/grade-fix";

test("a solo administrator adds, changes, corrects, promotes and edits a grade from empty", { tag: ["@hr", "@regression", "@first-run"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "gradefix", "직급상사");
  await setupCompany(admin, "직급상사", "본사");
  await startOperations(admin);
  await registerEmployee(admin, { name: "직급직원", number: "GF-001", unit: "본사", hired: "2025-01-01" });
  // Regression (e2e-load-stall-dev): the catalog arrives after the sheet opened, as under host load. The sheet draws
  // whole once it is in; drawn field by field, its chips landed above 언제부터 and moved it 43 px (gradeJourney's check).
  await admin.route("**/api/v1/job-titles", async (route) => (await new Promise((r) => setTimeout(r, 2_000)), route.continue()), { times: 1 });
  await admin.reload();
  await expect(admin.getByRole("heading", { name: /직급직원/, level: 1 })).toBeVisible();
  await gradeJourney(admin);
});

test("wrong-kind, inactive and missing catalog IDs are refused visibly without changing the grade", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "gradebad", "직급검증");
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, "직급검증", "본사");
  await startOperations(admin);
  await go(admin, "/people/job-titles");
  for (const [kind, label] of [["직급", "Valid"], ["직급", "Inactive"], ["직위", "Wrong kind"]]) {
    await option(admin, "목록", kind!).click();
    await admin.getByRole("textbox", { name: /^직위 이름/ }).fill(label!);
    await admin.getByRole("button", { name: "직위 추가", exact: true }).click();
    await expect(admin.getByRole("row").filter({ hasText: label! })).toBeVisible();
  }
  await admin.getByRole("button", { name: "Inactive 사용 중지", exact: true }).click();
  await expect(admin.getByRole("row").filter({ hasText: "Inactive" })).toContainText("사용 안 함");
  await registerEmployee(admin, { name: "검증직원", number: "GF-002", unit: "본사", hired: "2025-01-01" });
  const card = new URL(admin.url()).pathname;
  const catalog = await api("/job-titles");
  expect(catalog.status()).toBe(200);
  const entries = (await catalog.json()).items as { id: string; label: string }[];
  for (const id of [entries.find((x) => x.label === "Wrong kind")!.id, entries.find((x) => x.label === "Inactive")!.id, crypto.randomUUID()]) {
    const correct = await openGradeFix(admin, true);
    await expect(correct.getByRole("radio", { name: "Inactive", exact: true })).toHaveCount(0);
    await statement(correct.getByRole("radio", { name: "Valid", exact: true })).click();
    await statement(correct.getByRole("radio", { name: "입력 실수", exact: true })).click();
    const path = /\/api\/v1\/employees\/[^/]+$/;
    await admin.route(path, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const body = route.request().postDataJSON();
      await route.continue({ postData: JSON.stringify({ ...body, changes: { grade_id: id } }) });
    });
    const response = admin.waitForResponse((r) => r.request().method() === "PATCH" && path.test(new URL(r.url()).pathname));
    await correct.getByRole("button", { name: "정정", exact: true }).click();
    const refused = await response;
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.code).toBe("job_title_unknown");
    await expect(correct.getByRole("alert")).toContainText("저장하지 않았습니다");
    await expect(correct.getByRole("radio", { name: "Valid", exact: true })).toBeChecked();
    await correct.getByRole("button", { name: "취소", exact: true }).click();
    await admin.unroute(path);
    await go(admin, card);
    await expect(admin.locator("#f-grade")).not.toContainText("Valid");
  }
  // Reactivation is explicit; the existing catalog ID is retained.
  const correct = await openGradeFix(admin, true);
  await correct.getByRole("button", { name: "직급 추가", exact: true }).click();
  await correct.getByRole("textbox", { name: "새 직급 이름", exact: true }).fill("Inactive");
  await correct.getByRole("button", { name: "추가", exact: true }).click();
  await expect(correct).toContainText("Inactive는 사용 중지된 항목입니다");
  await expect(correct.getByRole("radio", { name: "Inactive", exact: true })).toHaveCount(0);
  await correct.getByRole("button", { name: "다시 사용하고 선택", exact: true }).click();
  await expect(correct.getByRole("radio", { name: "Inactive", exact: true })).toBeChecked();
  await statement(correct.getByRole("radio", { name: "입력 실수", exact: true })).click();
  await correct.getByRole("button", { name: "정정", exact: true }).click();
  await expect(correct).toBeHidden();
  await expect(admin.locator("#f-grade")).toContainText("Inactive");
  const reused = (await (await api("/job-titles")).json()).items.find((x: { label: string }) => x.label === "Inactive");
  expect(reused).toMatchObject({ id: entries.find((x) => x.label === "Inactive")!.id, active: true });
});
