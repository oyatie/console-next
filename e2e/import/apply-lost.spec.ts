import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { plain, workbook } from "../helpers/import-layouts";
import { apiOf, bearerOf, headcount } from "../helpers/api";

// regression (r3:hire-02): the apply ran inline, so under load the request hit its 30 s timeout as a generic 503
// while the server went on writing; the screen stayed on the dry run with 「명부 반영」 still pressable and no 이관 확인.
// Now the apply is a job: an answer that never arrives (the server got the request, the browser got nothing) is
// followed by reading the run, the job is shown to its end, and the migration check follows. Nothing is applied twice.
test("import apply: a lost answer re-reads the run and follows the job to the migration check, never offering apply again", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "applylost", "응답유실상사", false, "유실 본점");
  const api = apiOf(admin, bearerOf(admin));
  const rows = ["가람", "나래", "다솜"].map((name, i) => ({ number: `AL-000${i + 1}`, name, position: "사원", hired: "2020-03-02" }));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사기록.xlsx", await workbook([plain("본사", rows)]));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  const apply = admin.getByRole("button", { name: "명부 반영: 신규 3명 · 갱신 0명" });
  await expect(apply).toBeEnabled({ timeout: 30_000 });

  // The apply reaches the server, which starts the job; its answer is lost on the way back.
  let sent = 0;
  await admin.route(/\/import\/[^/]+\/apply$/, async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    sent += 1;
    expect(r.request().headers()["prefer"]).toBe("respond-async");
    await r.fetch();
    await r.abort("connectionreset");
  });
  await apply.click();

  // The run is read again: the job is followed (the apply is not offered again), to its end and the migration check.
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByRole("button", { name: /^명부 반영:/ })).toHaveCount(0);
  await expect(admin.getByRole("heading", { name: "이관 확인" })).toBeVisible();
  expect(sent).toBe(1);
  expect(await headcount(api)).toBe(3);
  await expectAccessible(admin, "import: a lost apply answer followed to the end");

  // Coming back after the job finished starts a new import (the finished job is not kept).
  await go(admin, "/people/import");
  await expect(admin.getByRole("heading", { name: "직원 명부 가져오기", level: 1 })).toBeVisible();
  await expect(admin.getByRole("region", { name: "명부 반영 중" })).toHaveCount(0);
});
