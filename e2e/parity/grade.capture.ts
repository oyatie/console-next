import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openTenant } from "../helpers/tenant";
import { go, option, registerEmployee } from "../flows";
import { setupCompany, startOperations } from "../setup-flows";
import { cardVerbs, hrAct, hrMenu, openHistory } from "../record";
import { reasonBox, sheet, signOff, statement, todayPreset } from "../sheet";
import { reasonChip } from "../helpers/lifecycle";
import { inlineAdd, openGradeFix } from "../helpers/grade-fix";
import { capture, inspect, ROOT } from "./capture";

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

// Catalog settings have no manifest frame: supplementary scenes never increase frame totals.
async function supplement(page: Page, name: string, observation: string) {
  mkdirSync(`${ROOT}/supplementary`, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, t) => { el.dataset.theme = t; }, theme);
    const file = `supplementary/${name}--${theme}.png`;
    await page.screenshot({ path: `${ROOT}/${file}` });
    writeFileSync(`node_modules/.cache/parity/${name}--${theme}.json`, JSON.stringify({ file, url: new URL(page.url()).pathname, observation, text: await page.locator("body").innerText() }));
  }
  await page.locator("html").evaluate((el) => { el.dataset.theme = "light"; });
}

test("parity grade: catalog-backed change, correction, promotion, roster and settings", async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await openTenant(browser, "parity-grade", "직급재검토");
  await setupCompany(a, "직급재검토", "본사");
  await startOperations(a);
  await registerEmployee(a, { name: "직급직원", number: "PG-001", unit: "본사", hired: "2025-01-01" });
  const card = new URL(a.url()).pathname;
  await a.getByRole("button", { name: "직급 수정", exact: true }).click();
  await expect(sheet(a, "직급 수정")).toBeVisible();
  await capture(a, "people", ["E4-grade-initial"], "Real card field chooser: dated grade change and reasoned correction; no grade or catalog entries yet.");
  await option(a, "무엇을 기록합니까", "직급이 바뀝니다 · 변경 (발령)").click();
  await sheet(a, "직급 수정").getByRole("button", { name: "다음", exact: true }).click();
  const change = sheet(a, "직급 수정 · 변경");
  await expect(change).toContainText("등록된 새 직급 항목이 없습니다");
  await inlineAdd(change, "직급", "사원");
  await statement(change.getByRole("radio", { name: /^오늘/ })).click();
  await statement(change.getByRole("radio", { name: "정기 승진", exact: true })).click();
  await capture(a, "people", ["E4-grade-change"], "Actual inline-created 사원 grade, today and explicit promotion reason, with a period table; future-overlap fixture not exercised.");
  await inspect(a, "people", "grade-change");
  await change.getByRole("button", { name: "승진 1명 반영", exact: true }).click();
  await expect(change).toBeHidden();
  await expect(a.locator("#f-grade")).toContainText("사원");
  await supplement(a, "grade-change-receipt", "Real applied grade write/read-back; card resolves the catalog label.");

  const correct = await openGradeFix(a, true);
  await inlineAdd(correct, "직급", "주임");
  await statement(correct.getByRole("radio", { name: "입력 실수", exact: true })).click();
  await expect(correct).toContainText("사원 → 주임");
  await supplement(a, "grade-correction", "Actual catalog-backed correction with old/new labels and explicit reason, no free-text grade.");
  await inspect(a, "people", "grade-correction");
  await correct.getByRole("button", { name: "정정", exact: true }).click();
  await expect(correct).toBeHidden();
  await expect(a.locator("#f-grade")).toContainText("주임");

  await hrMenu(a);
  await capture(a, "people", ["E5-menu"], "Actual operating HR menu; promotion remains reachable after catalog correction.");
  await a.keyboard.press("Escape");
  await hrAct(a, "승진 처리");
  const promote = sheet(a, "승진 · 강등");
  await inlineAdd(promote, "직급", "대리");
  await todayPreset(promote).click();
  await reasonChip(promote, "정기 승진").click();
  await reasonBox(promote).fill("직급 재검토");
  await signOff(promote);
  await expect(promote).toContainText(/주임\s*→\s*대리/);
  await supplement(a, "grade-promotion", "Actual single-person promotion preview names the grade delta; position remains unchanged.");
  await inspect(a, "people", "grade-promotion");
  await promote.getByRole("button", { name: "승진 1명 반영", exact: true }).click();
  await expect(promote).toBeHidden();
  await go(a, card);
  await expect(a.locator("#f-grade")).toContainText("대리");
  await capture(a, "people", ["E2-card"], "Actual one-person card after change, correction and promotion; catalog grade 대리 resolves. Full designed field/history/scale fixture remains unproved.");
  await inspect(a, "people", "grade-card");
  await openHistory(a);
  await expect(a.getByRole("region", { name: "인사 이력" })).toContainText("승진");
  await capture(a, "people", ["E2-history"], "Real promotion history after grade writes; not the full ideal evidence/withdrawal fixture.");
  await go(a, "/people");
  await expect(a.getByRole("row").filter({ hasText: "직급직원" })).toBeVisible();
  await capture(a, "people", ["E1-roster"], "Actual one-person roster after catalog-backed grade promotion; inspect column labels rather than infer a designed grade column.");
  await inspect(a, "people", "grade-roster");

  await go(a, "/people/job-titles");
  await expect(a.getByRole("row").filter({ hasText: "대리" })).toBeVisible();
  await supplement(a, "grade-catalog", "Actual settings catalog contains three UI-created grades; no dedicated catalog frame exists in the manifest.");
  await a.getByRole("button", { name: "대리 수정", exact: true }).click();
  const edit = a.getByRole("form", { name: "대리 목록 항목 수정" });
  await edit.getByRole("textbox", { name: /^서열/ }).fill("1001");
  const response = a.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/v1\/job-titles\/[^/]+$/.test(new URL(r.url()).pathname));
  await edit.getByRole("button", { name: "목록 항목 저장", exact: true }).click();
  const refused = await response;
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.code).toBe("job_title_rank_invalid");
  await expect(edit.getByRole("alert")).toBeVisible();
  await expect(a.getByRole("row").filter({ hasText: "대리" }).getByRole("cell", { name: "대리", exact: true })).toBeVisible();
  await supplement(a, "grade-catalog-refused", "Real server 422 job_title_rank_invalid retains input and original label; no invalid rank is stored.");
  await edit.getByRole("textbox", { name: /^직위 이름/ }).fill("선임");
  await edit.getByRole("textbox", { name: /^서열/ }).fill("20");
  await edit.getByRole("button", { name: "목록 항목 저장", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(a.getByRole("row").filter({ hasText: "선임" })).toContainText("20");
  await supplement(a, "grade-catalog-renamed", "Real catalog rename and rank update; historical grade IDs continue resolving to their current catalog label.");
  await inspect(a, "people", "grade-catalog");
  await go(a, card);
  await expect(a.locator("#f-grade")).toContainText("선임");
  await cardVerbs(a).getByRole("button", { name: "정정", exact: true }).click();
  await expect(a.getByRole("dialog")).toBeVisible();
  await capture(a, "people", ["E4-multi", "C-empty"], "Actual multi-field correction entry after grade rename; no interval/three-value conflict fixture.");
  await a.keyboard.press("Escape");
  await go(a, "/people");
  await a.getByRole("row").filter({ hasText: "직급직원" }).locator("label", { has: a.getByRole("checkbox") }).click();
  await a.getByRole("button", { name: "선택한 1명 일괄 발령", exact: true }).click();
  await a.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "승진", exact: true }).click();
  await expect(a.getByRole("textbox", { name: /^새 직위/ })).toBeVisible();
  await capture(a, "people", ["E6-promote"], "Actual bulk promotion for one selected person with GRADE catalog but no TITLE catalog: still a new-position text field, not the ideal per-person grade suggestion grid. No bulk write submitted.");
  await inspect(a, "people", "bulk-promotion");
});
