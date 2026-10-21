import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go } from "./flows";
import { tenantWithExecutive } from "./setup-flows";
import { rosterXlsx } from "./workbook";

const COMPANY = "명부주식회사";
const FAMILIES = ["김", "이", "박", "최", "정", "강", "조"];
const N = 3000;
const BATCH = 250;

/** The signed-in page's own access token, read off the app's next API call. */
async function bearer(page: Page) {
  const call = page.waitForRequest((r) => r.url().includes("/api/v1/") && Boolean(r.headers().authorization));
  await go(page, "/people");
  return (await call).headers().authorization!;
}

/**
 * 3,000 people through the import API (preview → dry run → apply bound to its digest) under the admin's own session:
 * every row is created by the product, without driving the import screen 3,000 rows deep (people.spec.ts does).
 * In batches: one apply of 3,000 rows outlasts the server's 30 s request timeout (408).
 */
async function importRoster(admin: Page) {
  const rows: string[][] = Array.from({ length: N }, (_, i) => [`E-${String(i + 1).padStart(4, "0")}`, `${FAMILIES[i % FAMILIES.length]}${String(i + 1).padStart(4, "0")}`, "인사팀", "사원", "2024-03-04"]);
  // Two Latin names, which the server lists after every Hangul one: React Aria's type-to-select would jump to them on "k".
  rows.push(["L-0001", "Kang Ari", "인사팀", "사원", "2024-03-04"], ["L-0002", "Kim Bora", "인사팀", "사원", "2024-03-04"]);
  const headers = { authorization: await bearer(admin) };
  const post = async <T>(path: string, body: { multipart?: Record<string, unknown>; data?: unknown }): Promise<T> => {
    const res = await admin.request.post(path, { headers, timeout: 60_000, ...(body as object) });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
    return (await res.json()) as T;
  };
  for (let at = 0; at < rows.length; at += BATCH) {
    const batch = rows.slice(at, at + BATCH);
    const file = { name: `roster-${at}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await rosterXlsx(COMPANY, batch) };
    const { run_id } = await post<{ run_id: string }>("/api/v1/employees/import/preview", { multipart: { file, pay_period_start: "2026-10-01", pay_period_end: "2026-10-31" } });
    const { dry_run_digest } = await post<{ dry_run_digest: string }>(`/api/v1/employees/import/${run_id}/dry-run`, { data: { decisions: {} } });
    const report = await post<{ inserted: number }>(`/api/v1/employees/import/${run_id}/apply`, { data: { dry_run_digest } });
    expect(report.inserted).toBe(batch.length);
  }
}

// G1 proofs (design §11): a 3,000-row roster stays virtualized, chips are server totals, the number jump,
// select-all only up to what one bulk command takes, J/K and / only inside the table, Back restores the search.
test("the roster at 3,000 people: virtualized paging, server counts, jump, bounded select-all, region-only keys", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(600_000);
  const { admin } = await tenantWithExecutive(browser, "rosterco", COMPANY);
  await importRoster(admin);
  const total = N + 2;
  const fmt = (n: number) => n.toLocaleString("ko-KR");

  // A fresh load, as the admin opening the app after the import: the roster this page showed before it is cached
  // as empty, and in-app the change would surface only as the "list changed" banner.
  await admin.goto("/people");
  const table = admin.getByRole("grid", { name: "직원" });
  await expect(admin.getByText(`100 / ${fmt(total)}줄`)).toBeVisible();
  // The chips are the filter, each with the server's total; the pressed one equals the list's count.
  const status = admin.getByRole("group", { name: "상태" });
  await expect(status.getByRole("button", { name: `재직 ${fmt(total)}` })).toBeVisible();
  await expect(status).toContainText(`인원 ${fmt(total)}`); // 재직 + 휴직 = 인원, the list's count
  await expectAccessible(admin, "roster: 3,000 people");

  // Select-all: more than one bulk command takes (500) is offered disabled, with why and the fix beside it.
  // The header box selects the loaded page; its label takes the click (the checkbox input is visually hidden).
  const pageBox = table.getByRole("row").first().locator("label", { has: admin.getByRole("checkbox") });
  await pageBox.click();
  const selectAll = admin.getByRole("button", { name: `필터와 일치하는 ${fmt(total)}명 모두 선택` });
  await expect(selectAll).toHaveAttribute("aria-disabled", "true");
  await expect(selectAll).toHaveAccessibleDescription(`필터와 일치하는 ${fmt(total)}명은 한 번에 발령할 수 없습니다`);
  await expect(admin.getByText("조건을 좁혀 500명 이하로 만드십시오")).toBeVisible();
  await expectAccessible(admin, "roster: select-all over the bulk limit");
  await admin.getByRole("button", { name: "선택 해제" }).click();

  // Scroll to the end: every page loads, while the DOM keeps only the rows in view.
  const grid = table.elementHandle();
  const toEnd = async () => {
    for (let i = 0; i < 80 && !(await admin.getByText(`${fmt(total)} / ${fmt(total)}줄`, { exact: true }).isVisible()); i++) {
      await (await grid)!.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await admin.waitForTimeout(150);
    }
    await (await grid)!.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(admin.getByText(`${fmt(total)} / ${fmt(total)}줄`, { exact: true })).toBeVisible();
  };
  await toEnd();
  await expect(table.getByRole("rowheader", { name: "E-3000", exact: true })).toBeVisible();
  expect(await table.getByRole("row").count()).toBeLessThan(60);

  // Every row loaded and ticked by the header box: more than one bulk command takes, so the command says why.
  await pageBox.click();
  const bulk = admin.getByRole("button", { name: `선택한 ${fmt(total)}명 일괄 발령` });
  await expect(bulk).toHaveAttribute("aria-disabled", "true");
  await expect(bulk).toHaveAccessibleDescription("한 번에 500명까지 발령할 수 있습니다. 선택을 줄이십시오");
  await admin.getByRole("button", { name: "선택 해제" }).click();
  await (await grid)!.evaluate((el) => (el.scrollTop = 0));

  // A search narrows it to ≤ 500: select-all is offered, and a filter change drops that saved query.
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("김");
  await find.press("Enter");
  const kims = Math.ceil(N / FAMILIES.length);
  await expect(admin.getByText(`100 / ${fmt(kims)}줄`)).toBeVisible();
  await pageBox.click();
  await admin.getByRole("button", { name: `필터와 일치하는 ${fmt(kims)}명 모두 선택` }).click();
  await expect(admin.getByRole("status").filter({ hasText: `필터와 일치하는 ${fmt(kims)}명 선택됨` })).toBeVisible();
  await admin.getByRole("group", { name: "확인 필요" }).getByRole("button", { name: /^반영 실패/ }).click();
  await expect(admin.getByRole("status").filter({ hasText: "선택됨" })).toHaveCount(0);
  await admin.getByRole("group", { name: "확인 필요" }).getByRole("button", { name: /^반영 실패/ }).click();

  // Single-key shortcuts work only inside the table's region, and J/K beat type-to-select ("k" is not a jump to Kim).
  await find.fill("");
  await find.press("Enter");
  await expect(admin.getByText(new RegExp(` / ${fmt(total)}줄$`))).toBeVisible(); // the pages scrolled through earlier are still cached
  await admin.getByRole("heading", { name: "직원", level: 1 }).focus();
  await admin.keyboard.press("/");
  await expect(find).not.toBeFocused();
  await toEnd(); // the Latin names are the last rows
  await table.getByRole("rowheader", { name: "E-3000", exact: true }).click(); // opens the panel
  const panel = admin.getByRole("complementary", { name: "직원 상세" });
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("E-3000");
  await admin.keyboard.press("j");
  await admin.keyboard.press("j");
  await expect(table.locator("[role=row]:focus-within")).toContainText("Kim Bora");
  await admin.keyboard.press("k");
  await expect(table.locator("[role=row]:focus-within")).toContainText("Kang Ari"); // one row up, not a jump
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("Kang Ari"); // the panel follows
  await expectAccessible(admin, "roster: row selected, panel open");
  await admin.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await admin.keyboard.press("/");
  await expect(find).toBeFocused();

  // Enter on an exact employee number opens that person; Back returns to the same search.
  await find.fill("e-1234");
  await find.press("Enter");
  await expect(admin.getByRole("heading", { level: 1 }).locator("..")).toContainText("E-1234");
  await admin.goBack();
  await expect(find).toHaveValue("e-1234");
  await expect(table.getByRole("rowheader", { name: "E-1234", exact: true })).toBeVisible();
});
