import { expect, type Locator, type Page } from "@playwright/test";
import { jobTitleSchemas } from "@console/api";
import { i18n, loadCatalog, t } from "@console/i18n";
import { apiOf, bearerOf } from "./api";
import { expectAccessible } from "../a11y";
import { go, option } from "../flows";
import { hrAct } from "../record";
import { reasonBox, sheet, signOff, statement, todayPreset } from "../sheet";
import { reasonChip } from "./lifecycle";

export async function inlineAdd(s: Locator, what: string, label: string) {
  await s.getByRole("button", { name: `${what} 추가`, exact: true }).click();
  const input = s.getByRole("textbox", { name: `새 ${what} 이름` });
  await expect(input).toHaveAttribute("maxlength", String(jobTitleSchemas.create.properties.label.maxLength));
  await input.fill(label);
  await s.getByRole("button", { name: "추가", exact: true }).click();
  await expect(s.getByRole("radio", { name: label, exact: true })).toBeChecked();
}

export async function openGradeFix(page: Page, correct: boolean) {
  await page.getByRole("button", { name: "직급 수정", exact: true }).click();
  const choose = sheet(page, "직급 수정");
  await option(page, "무엇을 기록합니까", correct ? "처음부터 잘못 적었습니다 · 정정" : "직급이 바뀝니다 · 변경 (발령)").click();
  await choose.getByRole("button", { name: "다음", exact: true }).click();
  return sheet(page, correct ? "직급 정정" : "직급 수정 · 변경");
}

/** The form refuses invalid input; the authenticated API independently enforces the same contract. */
export async function assertRankRefusal(page: Page, edit: Locator, label: string, api: ReturnType<typeof apiOf>) {
  await loadCatalog("ko");
  i18n.set("ko");
  const { minimum, maximum } = jobTitleSchemas.update.properties.grade_rank;
  const writes: string[] = [];
  const watch = (request: import("@playwright/test").Request) => {
    if (request.method() === "PATCH" && /\/api\/v1\/job-titles\/[^/]+$/.test(new URL(request.url()).pathname)) writes.push(request.url());
  };
  page.on("request", watch);
  try {
    const rank = edit.getByRole("textbox", { name: t("titles.col.rank") });
    await rank.fill(String(maximum + 1));
    await expect(edit.getByRole("button", { name: t("titles.edit.commit"), exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(rank).toHaveAttribute("aria-invalid", "true");
    await expect(edit).toContainText(t("titles.rank.bad", { min: minimum, max: maximum }));
    await rank.press("Enter");
    await edit.evaluate(element => (element as HTMLFormElement).requestSubmit());
    await expect(edit).toBeVisible();
    expect(writes).toEqual([]);
  } finally { page.off("request", watch); }
  const entries = (await (await api("/job-titles")).json()).items as { id: string; label: string; grade_rank: number | null }[];
  const entry = entries.find(item => item.label === label)!;
  expect(entry).toBeDefined();
  const refused = await api(`/job-titles/${entry.id}`, "PATCH", { grade_rank: maximum + 1 });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.code).toBe("job_title_rank_invalid");
  const after = (await (await api("/job-titles")).json()).items;
  expect(after.find((item: { id: string }) => item.id === entry.id)).toMatchObject(entry);
}

/** All five CX-grade-fix paths on the already-open card, as one administrator. */
export async function gradeJourney(page: Page) {
  const api = apiOf(page, bearerOf(page));
  const card = new URL(page.url()).pathname;
  const change = await openGradeFix(page, false);
  await expect(change).toContainText("등록된 새 직급 항목이 없습니다");
  await inlineAdd(change, "직급", "G1");
  await statement(change.getByRole("radio", { name: /^오늘/ })).click();
  await statement(change.getByRole("radio", { name: "정기 승진", exact: true })).click();
  await expectAccessible(page, "grade: inline add and dated change");
  await change.getByRole("button", { name: "승진 1명 적용", exact: true }).click();
  await expect(change).toBeHidden();
  await expect(page.locator("#f-grade")).toContainText("G1");

  const correct = await openGradeFix(page, true);
  await expect(correct.getByRole("textbox")).toHaveCount(0);
  await inlineAdd(correct, "직급", "G2");
  await statement(correct.getByRole("radio", { name: "입력 실수", exact: true })).click();
  await expect(correct).toContainText("G1 → G2");
  await expectAccessible(page, "grade: catalog correction");
  await correct.getByRole("button", { name: "인사 정보 1명 정정", exact: true }).click();
  await expect(correct).toBeHidden();
  await expect(page.locator("#f-grade")).toContainText("G2");

  await hrAct(page, "승진 처리");
  const promote = sheet(page, "승진 · 강등");
  await inlineAdd(promote, "직급", "G3");
  await promote.getByRole("button", { name: "그대로", exact: true }).click();
  await expect(promote.getByRole("radio", { name: "G3", exact: true })).not.toBeChecked();
  await statement(promote.getByRole("radio", { name: "G3", exact: true })).click();
  await todayPreset(promote).click();
  await reasonChip(promote, "정기 승진").click();
  await reasonBox(promote).fill("직급 승진");
  await signOff(promote);
  await promote.getByRole("button", { name: "승진 1명 적용", exact: true }).click();
  await expect(promote).toBeHidden();
  await go(page, card);
  await expect(page.locator("#f-grade")).toContainText("G3");

  await go(page, "/people/job-titles");
  const row = page.getByRole("row").filter({ hasText: "G3" });
  await row.getByRole("button", { name: "G3 수정", exact: true }).click();
  const edit = page.getByRole("form", { name: "G3 목록 항목 수정" });
  await assertRankRefusal(page, edit, "G3", api);
  await expect(row.getByRole("cell", { name: "G3", exact: true })).toBeVisible();
  await edit.getByRole("textbox", { name: /^직위 이름/ }).fill("Senior grade");
  await edit.getByRole("textbox", { name: /^서열/ }).fill("20");
  await expectAccessible(page, "catalog: rename and rank");
  await edit.getByRole("button", { name: "목록 항목 저장", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Senior grade" })).toContainText("20");
  await expect(page.getByRole("columnheader", { name: "서열", exact: true })).toBeVisible();
  await go(page, card);
  await expect(page.locator("#f-grade")).toContainText("Senior grade");
}
