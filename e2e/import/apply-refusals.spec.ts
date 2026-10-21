import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook } from "../helpers/import";
import { plain, workbook } from "../helpers/import-layouts";
import { apiOf, bearerOf, headcount } from "../helpers/api";

// What the import screen says when the server sheds or refuses an apply (BE-MIG W11, contract-mig.md UI refusals 3-6),
// from an empty company. The server-side refusals are BE-MIG's tests (mig_job, import_job_routes: status, code, no job,
// nothing written); here each answer is played to the screen once, and the screen must name it, keep the way out and
// send nothing more: 422 import_row_limit (max and rows named, split the file), 503 import_apply_busy (the apply held
// for its Retry-After, no second press), 409 apply_in_progress and a job that failed before writing (apply_interrupted).
// Every refused press leaves nobody written; the last press is real and writes the two people.

const answer = (status: number, code: string, refusals?: object[]) => ({ status, json: { error: { code, message: code, ...(refusals ? { refusals } : {}) } } });

async function once(page: Page, path: RegExp, a: ReturnType<typeof answer>) {
  let left = 1;
  await page.route(path, (r) => (r.request().method() === "POST" && left-- > 0 ? r.fulfill(a) : r.continue()));
}

test("import apply refusals: row limit, a shed apply held for its wait, a job already running, an interrupted job", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "applyno", "반영거절상사", false, "거절 본점");
  const api = apiOf(admin, bearerOf(admin));
  const rows = ["가람", "나래"].map((name, i) => ({ number: `AR-000${i + 1}`, name, position: "사원", hired: "2020-03-02" }));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사기록.xlsx", await workbook([plain("본사", rows)]));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();

  // 422 import_row_limit on the dry run: the file's rows and the most one apply takes are named, with what to do.
  await once(admin, /\/import\/[^/]+\/dry-run$/, answer(422, "import_row_limit", [{ max: 2000, rows: 2500 }]));
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await expect(admin.getByRole("alert")).toContainText("이 파일의 재직자는 2,500명이라 한 번에 반영할 수 있는 2,000명을 넘습니다");
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  const apply = admin.getByRole("button", { name: "명부 반영: 신규 2명 · 갱신 0명" });
  await expect(apply).toBeEnabled({ timeout: 30_000 });

  // 503 import_apply_busy: said, nothing written, and the apply is held (says why) instead of pressed again at once.
  await once(admin, /\/import\/[^/]+\/apply$/, answer(503, "import_apply_busy"));
  await apply.click();
  await expect(admin.getByRole("alert")).toContainText("15초 뒤에 다시 반영할 수 있습니다");
  await expect(admin.getByRole("button", { name: "명부 반영: 신규 2명 · 갱신 0명" })).toHaveAttribute("aria-disabled", "true");
  expect(await headcount(api)).toBe(0);
  await expectAccessible(admin, "import: a shed apply");
  await expect(apply).toBeEnabled({ timeout: 20_000 });
  await expect(apply).not.toHaveAttribute("aria-disabled", "true", { timeout: 20_000 });

  // 409 apply_in_progress, then a job that stopped before writing: each named, the apply still there, nobody written.
  for (const [code, words] of [["apply_in_progress", "이 가져오기를 지금 반영하는 중입니다"], ["apply_interrupted", "반영이 쓰기 전에 끊겼습니다"]] as const) {
    await once(admin, /\/import\/[^/]+\/apply$/, answer(409, code));
    await apply.click();
    await expect(admin.getByRole("alert")).toContainText(words);
    await expect(apply).toBeVisible();
    expect(await headcount(api)).toBe(0);
  }

  // The real press writes the two people once.
  await apply.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  expect(await headcount(api)).toBe(2);
});
