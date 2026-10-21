import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go } from "./flows";
import { world } from "./parity/world-b";
import { apiOf, bearerOf } from "./helpers/api";

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
  await expect(admin.getByRole("status").filter({ hasText: "5명 배치 끝" })).toBeVisible();
  // The sixth person alone, directly under the workplace: the group is done and the next one opens.
  await c.click(rows.getByRole("row").nth(1).getByText("따로 배치"));
  await c.click(admin.getByRole("button", { name: "사업장 직속 배치" }));
  await expect(admin.getByRole("status").filter({ hasText: "1명 배치 끝" })).toBeVisible();
  await expect(groups.getByRole("button", { name: /「아산」/ })).toHaveAttribute("aria-pressed", "true");
  expect(c.done("place a group of 6")).toBeLessThanOrEqual(10);
  expect(await queued()).toBe(before - 6);
  await expectAccessible(admin, "unplaced: a group placed");

  // The roster shows them where they were placed.
  await go(admin, "/people");
  const search = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await search.fill("10003");
  await expect(admin.getByRole("row").filter({ hasText: "10003" })).toContainText(/생산2팀|평택공장/);
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
