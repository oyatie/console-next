import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate } from "./flows";
import { openTenant } from "./helpers/tenant";
import { chooseWorkbook, people, rosterWorkbook } from "./helpers/import";
import { apiOf, bearerOf } from "./helpers/api";
import { setupCompany, startOperations } from "./setup-flows";
import { addDepartments } from "./structure-flows";
import { fillDate } from "./sheet";

// r3:hire-03, hire-21, EMP-E12-queue-empty (regression): a whole group of 미배치 people placed at once was refused
// 422 with no names; the queue showed 「— — —」 for people past the roster's first 1,000; a finished queue was a dead end.

const ENTITY = "배치정밀";
const SITE = "평택공장";

/** A tenant in setup with 경영지원부 › 인사팀, and `n` people whose 부서 「총무팀」 is not a unit (they come in 미배치). */
async function world(page: Page, slug: string, n: number) {
  await setupCompany(page, ENTITY, SITE);
  await go(page, "/org");
  await addDepartments(page, SITE, ["경영지원부"]);
  await addDepartments(page, "경영지원부", ["인사팀"]);
  const rows = people("PL", n, ["총무팀"], [SITE]).map((p) => ({ ...p, position: "과장" }));
  await go(page, "/people/import");
  await chooseWorkbook(page, `${slug}.xlsx`, await rosterWorkbook([{ name: "재직자", rows }]));
  await page.getByRole("button", { name: "명부 미리보기" }).click();
  await page.getByRole("button", { name: "모의 반영 실행" }).click({ timeout: 60_000 });
  const apply = page.getByRole("button", { name: new RegExp(`^명부 반영: 신규 ${n}명`) });
  await expect(apply).toBeEnabled({ timeout: 60_000 });
  await apply.click();
  await expect(page.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 120_000 });
  return rows;
}

const queued = async (api: ReturnType<typeof apiOf>) => ((await (await api("/employees/import/unplaced?limit=1")).json()) as { count: number }).count;

async function pickAll(page: Page, n: number) {
  await go(page, "/people/unplaced");
  const groups = page.getByRole("complementary", { name: /원본 값별/ });
  await groups.getByRole("button", { name: /「총무팀」/ }).click();
  await page.getByRole("button", { name: `${n}명 모두 선택` }).click();
  const find = page.getByRole("combobox", { name: "둘 부서" });
  await find.fill("인사팀");
  await page.getByRole("option", { name: /인사팀/ }).click();
}

for (const operating of [false, true]) test(`unplaced: a whole group is placed at once, with its facts shown, and a finished queue says what to do next (${operating ? "operating" : "setup"})`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, operating ? "placeallop" : "placeall", "배치그룹");
  const api = apiOf(admin, bearerOf(admin));
  const rows = await world(admin, "placeall", 8);
  const facets = await (await api("/employees/facets")).json() as { review: { home_branch_review_required: number } };
  expect(facets.review.home_branch_review_required).toBe(0);
  if (operating) await startOperations(admin);
  await go(admin, "/people/unplaced");
  await expect(admin.getByText("사업장 없음 · 배치 0명 · 부서 없음 · 지정 8명")).toBeVisible();
  const grid = admin.getByRole("grid", { name: "미배치 처리" });
  // hire-21: the queue's own facts (직위 · 고용형태 · 입사일), never 「—」 for a person whose record has them.
  await expect(grid.getByRole("row").filter({ hasText: rows[0]!.number })).toContainText("과장");
  await expect(grid.getByRole("row").filter({ hasText: rows[0]!.number })).toContainText("정규직");
  await expect(grid.getByRole("row").filter({ hasText: "—" })).toHaveCount(0);
  await pickAll(admin, 8);
  const effectiveDate = kstDate(-1);
  if (operating) {
    await expect(admin.getByRole("button", { name: "선택한 부서에 배치" })).toHaveAttribute("aria-disabled", "true");
    await fillDate(admin, effectiveDate);
  }
  await admin.getByRole("button", { name: "선택한 부서에 배치" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "8명 배치 끝" })).toBeVisible({ timeout: 30_000 });
  const directory = await (await api(`/employees?search=${encodeURIComponent(rows[0]!.number)}`)).json() as { items: { id: string }[] };
  expect(directory.items).toHaveLength(1);
  const history = await (await api(`/employees/${directory.items[0]!.id}/lifecycle-events`)).json() as { items: { event_type: string; effective_date: string }[] };
  expect(history.items).toContainEqual(expect.objectContaining({ event_type: "TRANSFER", effective_date: operating ? effectiveDate : kstDate() }));
  expect(await queued(api)).toBe(0);
  // EMP-E12-queue-empty: done, with the next steps.
  await expect(admin.getByRole("heading", { name: /미배치를 모두 처리했습니다/ })).toBeVisible();
  await expect(admin.getByRole("link", { name: "직원 목록 보기" })).toBeVisible();
  await expectAccessible(admin, "unplaced: finished");
});

test("unplaced: a future operating placement stays in the current queue until its effective date", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "placefuture", "배치예약");
  const api = apiOf(admin, bearerOf(admin));
  await world(admin, "placefuture", 1);
  await startOperations(admin);
  await pickAll(admin, 1);
  await fillDate(admin, kstDate(1));
  await admin.getByRole("button", { name: "선택한 부서에 배치" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1명 배치를 예약했습니다" })).toBeVisible();
  expect(await queued(api)).toBe(1);
  await expect(admin.getByRole("heading", { name: /미배치를 모두 처리했습니다/ })).toHaveCount(0);
});

test("unplaced: people the server would refuse are named with the reason; nothing is written until the rest are placed alone", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "placeno", "배치거절");
  const api = apiOf(admin, bearerOf(admin));
  // Two of the four are refused by the server's check (played once to the screen; the server's own refusal shape is
  // the backend suites').
  await world(admin, "placeno", 4);
  const queue = (await (await api("/employees/import/unplaced?limit=10")).json()) as { items: { employee_id: string; name: string }[] };
  const ids = queue.items.slice(0, 2).map((q) => ({ id: q.employee_id, name: q.name }));
  expect(ids).toHaveLength(2);
  let left = 1;
  await admin.route("**/api/v1/employees/lifecycle-events/bulk/preview", async (r) => {
    if (left-- <= 0) return r.continue();
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, counts: { ...real.counts, refused: 2 }, refusals: ids.map((p) => ({ employee_id: p.id, code: "lifecycle_before_hire", message: "before hire" })) } });
  });
  await pickAll(admin, 4);
  await admin.getByRole("button", { name: "선택한 부서에 배치" }).click();
  const held = admin.getByRole("alert").filter({ hasText: "아무도 배치하지 않았습니다" });
  await expect(held).toContainText("4명 중 2명");
  for (const p of ids) await expect(held.getByRole("list")).toContainText(p.name);
  await expect(held.getByRole("link", { name: "인사카드에서 수정" })).toHaveCount(2);
  expect(await queued(api)).toBe(4);
  await expectAccessible(admin, "unplaced: refused people named");
  await held.getByRole("button", { name: "나머지 2명만 배치" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "2명 배치 끝" })).toBeVisible({ timeout: 30_000 });
  expect(await queued(api)).toBe(2);
});
