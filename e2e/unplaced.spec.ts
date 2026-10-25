import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, kstDate } from "./flows";
import { world } from "./parity/world-b";
import { apiOf, bearerOf } from "./helpers/api";
import { startOperations } from "./setup-flows";
import { fillDate } from "./sheet";

// E8 미배치 처리 (spec employee-ux E8): people an import could not place, grouped by the file's work-place value; a
// group is placed by picking people and a place (a numbered suggestion, a search, or directly under the workplace).
test("unplaced people: grouped by the file's value, placed in a unit or directly under the workplace, each group closes when done", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await world(browser, 2, "unplaced");
  const api = apiOf(admin, bearerOf(admin));
  // The page's bearer is read off its own requests: retried until one has been seen.
  const queued = async () => {
    let count = -1;
    await expect(async () => {
      const r = await api("/employees/import/unplaced?limit=1");
      expect(r.status()).toBe(200);
      count = ((await r.json()) as { count: number }).count;
    }).toPass({ timeout: 15_000 });
    return count;
  };
  const c = clickCounter();
  await go(admin, "/people/unplaced");
  await expect(admin.getByRole("heading", { name: "미배치 처리", level: 1 })).toBeVisible();
  // Who is unplaced is the server's queue (BE-MIG): the head counts it.
  const before = await queued();
  await expect(admin.getByText(new RegExp(`남은 사람 ${before} `))).toBeVisible();
  const groups = admin.getByRole("complementary", { name: /원본 값별/ });
  await expect(groups.getByRole("button", { name: /「평택 1공장」/ })).toContainText("6");
  await expectAccessible(admin, "unplaced: queue");

  const rows = admin.getByRole("grid", { name: "미배치 처리" });
  const pick = async (n: number) => {
    for (let i = 0; i < n; i++) await c.click(rows.getByRole("row").nth(i + 1).locator("label", { has: admin.getByRole("checkbox") }));
  };
  await c.click(groups.getByRole("button", { name: /「평택 1공장」/ }));
  await pick(5);
  const find = admin.getByRole("combobox", { name: "둘 부서" });
  await find.fill("생산2팀");
  await c.click(admin.getByRole("option", { name: /생산2팀/ }));
  await c.click(admin.getByRole("button", { name: "선택한 부서에 배치" }));
  await expect(admin.getByRole("status").filter({ hasText: "5명 배치 끝" })).toBeVisible({ timeout: 30_000 });
  // The sixth person alone, directly under the workplace: the group is done and the next one opens.
  await c.click(rows.getByRole("row").nth(1).getByText("따로 배치"));
  await c.click(admin.getByRole("button", { name: "사업장 직속 배치" }));
  await expect(admin.getByRole("status").filter({ hasText: "1명 배치 끝" })).toBeVisible({ timeout: 30_000 });
  await expect(groups.getByRole("button", { name: /「아산」/ })).toHaveAttribute("aria-pressed", "true");
  expect(c.done("place a group of 6")).toBeLessThanOrEqual(10);
  expect(await queued()).toBe(before - 6);
  // The original world contains hires on both sides of the opening date. The queue and import use one rule.
  const directory = await (await api("/employees?limit=100")).json() as { items: { id: string; employee_number: string; hire_date: string }[] };
  const placed = directory.items.filter((p) => ["10003", "10004", "10006", "10009", "10012", "10016"].includes(p.employee_number));
  expect(placed).toHaveLength(6);
  const entities = await (await api("/legal-entities")).json() as { items: { workplaces: { id: string; placement_opens_on: string }[] }[] };
  const openings = new Map(entities.items.flatMap((e) => e.workplaces.map((w) => [w.id, w.placement_opens_on] as const)));
  const orders = new Set<boolean>();
  for (const person of placed) {
    const assignments = await (await api(`/employment-assignments?employee_id=${person.id}`)).json() as { items: { valid_from: string; workplace_id: string }[] };
    expect(assignments.items).toHaveLength(1);
    const assignment = assignments.items[0]!;
    const opened = openings.get(assignment.workplace_id)!;
    expect(opened).toBeTruthy();
    orders.add(person.hire_date < opened);
    expect(assignment.valid_from).toBe(person.hire_date > opened ? person.hire_date : opened);
  }
  expect([...orders].sort()).toEqual([false, true]);
  await expectAccessible(admin, "unplaced: a group placed");

  // The roster shows them where they were placed.
  await go(admin, "/people");
  const search = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await search.fill("10003");
  await expect(admin.getByRole("row").filter({ hasText: "10003" })).toContainText(/생산2팀|평택공장/);
});

test("an operating placement before opening names the refusal and leaves no transfer or assignment", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await world(browser, 0, "unplacedopening");
  const api = apiOf(admin, bearerOf(admin));
  await startOperations(admin);
  await go(admin, "/people/unplaced");
  const groups = admin.getByRole("complementary", { name: /원본 값별/ });
  await groups.getByRole("button", { name: /「평택 1공장」/ }).click();
  const row = admin.getByRole("grid", { name: "미배치 처리" }).getByRole("row").nth(1);
  await row.locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("combobox", { name: "둘 부서" }).fill("생산2팀");
  await admin.getByRole("option", { name: /생산2팀/ }).click();
  const entities = await (await api("/legal-entities")).json() as { items: { workplaces: { placement_opens_on: string }[] }[] };
  const opening = entities.items[0]!.workplaces[0]!.placement_opens_on;
  const beforeOpening = new Date(`${opening}T00:00:00Z`);
  beforeOpening.setUTCDate(beforeOpening.getUTCDate() - 1);
  await fillDate(admin, beforeOpening.toISOString().slice(0, 10));
  const response = admin.waitForResponse((r) => r.url().endsWith("/lifecycle-events/bulk/preview"));
  await admin.getByRole("button", { name: "선택한 부서에 배치" }).click();
  const preview = await (await response).json() as { refusals: { employee_id: string; code: string }[] };
  expect(preview.refusals).toHaveLength(1);
  expect(preview.refusals[0]!.code).toBe("workplace_not_open_on_date");
  await expect(admin.getByRole("alert").filter({ hasText: "아무도 배치하지 않았습니다" })).toBeVisible();
  const id = preview.refusals[0]!.employee_id;
  for (const path of [`/employees/${id}/lifecycle-events`, `/employment-assignments?employee_id=${id}`]) {
    const read = await (await api(path)).json() as { items: unknown[] };
    expect(read.items).toHaveLength(0);
  }
  expect(((await (await api("/employees/import/unplaced?limit=1")).json()) as { count: number }).count).toBe(17);
  await admin.getByRole("button", { name: "아무도 배치하지 않고 닫기" }).click();
  await fillDate(admin, kstDate());
  await admin.getByRole("button", { name: "선택한 부서에 배치" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1명 배치 끝" })).toBeVisible();
  const placed = await (await api(`/employment-assignments?employee_id=${id}`)).json() as { items: { valid_from: string }[] };
  expect(placed.items).toEqual([expect.objectContaining({ valid_from: kstDate() })]);
});

// A reader the server does not let manage the directory (403 on the queue, BE-MIG W03): an honest no-access state, never
// an empty queue read as 「남은 사람 0」 and no place to put anyone.
test("unplaced people: a refused queue reads as no access, not as nobody left", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await world(browser, 2, "unplacedno");
  await admin.route("**/api/v1/employees/import/unplaced**", (r) => r.fulfill({ status: 403, json: { error: { code: "forbidden", message: "forbidden" } } }));
  await go(admin, "/people/unplaced");
  await expect(admin.getByRole("heading", { name: "접근 권한이 없습니다" })).toBeVisible();
  await expect(admin.getByText(/남은 사람/)).toHaveCount(0);
  await expect(admin.getByRole("button", { name: "선택한 부서에 배치" })).toHaveCount(0);
  await expectAccessible(admin, "unplaced: no access");
});
