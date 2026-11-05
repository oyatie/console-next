// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, unique } from "../flows";
import { openTenant } from "../helpers/tenant";
import { setupCompany } from "../setup-flows";
import { apiOf, bearerOf, headcount } from "../helpers/api";
import { chooseWorkbook } from "../helpers/import";
import { workbook } from "../helpers/import-layouts";
import { settled } from "../helpers/import-queue";
import { psql } from "../idle-fixture";
import { atPhoneWidth, expectAccessible, fits } from "../a11y";
import { shotSet } from "../shots";
import { forgetResize } from "../stability";

test("an interrupted import leaves no people and retry replays the complete report", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const slug = "atomicimport";
  const admin = await openTenant(browser, slug, "이관검증");
  await setupCompany(admin, "이관검증", "본점");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "검증명부.xlsx", await workbook([{ name: "명부", lines: [
    ["사번", "성명", "입사일", "고용형태"],
    ["AT-001", "가검증", "2020-03-02", "정규직"],
    ["AT-002", "나검증", "2021-04-01", "정규직"],
  ] }]));
  const previewed = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/import/preview"));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const { run_id: run } = await (await previewed).json() as { run_id: string };
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await settled(admin);
  // Fault injection only: the tenant, structure and workbook all use the product.
  psql(unique(slug), `CREATE FUNCTION fail_import_settle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action='employee.import.settle' AND NEW.target_id='${run}' THEN
  RAISE EXCEPTION 'injected settle failure';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fail_import_settle AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_import_settle();`);
  const applyPath = `/employees/import/${run}/apply`;
  try {
    await admin.getByRole("button", { name: /^명부 반영: 신규 2명/ }).click();
    await expect.poll(async () => (await (await api(applyPath)).json()).state, { timeout: 60_000 }).toBe("failed");
    await shotSet(admin, "import-interrupted");
    await forgetResize(admin);
    expect(await headcount(api), "the failed apply must leave the roster empty").toBe(0);
    await expect(admin.getByText("반영하지 못했습니다", { exact: true })).toBeVisible();
  } finally {
    psql(unique(slug), "DROP TRIGGER fail_import_settle ON audit_events; DROP FUNCTION fail_import_settle();");
  }
  await admin.getByRole("button", { name: "모의 반영으로 돌아가기" }).click();
  const applied = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(applyPath));
  await admin.getByRole("button", { name: /^명부 반영: 신규 2명/ }).click();
  const response = await applied;
  expect([200, 202]).toContain(response.status());
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  const job = await (await api(applyPath)).json();
  expect(job.state).toBe("done");
  expect(job.report.inserted).toBe(2);
  const replay = await api(applyPath, "POST", { dry_run_digest: job.dry_run_digest });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(job.report);
  expect(await headcount(api)).toBe(2);
  await expectAccessible(admin, "completed atomic import");
  await atPhoneWidth(admin, () => fits(admin, "completed atomic import"));
  await shotSet(admin, "import-retried");
  await admin.reload();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible();
  expect(await headcount(api)).toBe(2);
});
