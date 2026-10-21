import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { fillRegister, pressRegister, receiptOf, registerSheet } from "./helpers/register";
import { apiAs, faultNext, NETWORK_ERROR, sent, soloTenant } from "./chaos";
import { go, kstDate } from "./flows";
import { setupCompany } from "./setup-flows";
import { addDepartments } from "./structure-flows";
import { rosterXlsx } from "./workbook";
import { chooseWorkbook, payPeriod } from "./helpers/import";

// People on a bad connection keep the original intent and check its outcome, so each person lands once.

type Page_ = { items: { name: string }[]; total: number };

/** A tenant in setup with one 법인, its 본사 and a 인사팀 under it, alone. */
async function setupTenant(browser: import("@playwright/test").Browser, slug: string, name: string) {
  const admin = await soloTenant(browser, slug, name);
  await setupCompany(admin, name, "본사");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사팀"]);
  return admin;
}

test("register on a bad connection: a lost answer still makes one employee, and a double press registers once", { tag: "@chaos" }, async ({ browser }) => {
  const admin = await setupTenant(browser, "chaosreg", "혼돈등록");
  const read = apiAs(admin);
  const named = async (n: string) => (await read<Page_>(`/api/v1/employees?search=${encodeURIComponent(n)}`)).items.filter((e) => e.name === n);

  await go(admin, "/people/new");
  await fillRegister(admin, { name: "유실직원", number: "CH-0001", unit: "인사팀", hired: kstDate() });
  const creates = sent(admin, /\/api\/v1\/employees$/);
  // The server registers the person, the answer is lost: keep the form and follow the durable outcome without resending.
  await faultNext(admin, /\/api\/v1\/employees$/, "lost");
  await pressRegister(admin);
  const checking = registerSheet(admin).getByRole("alert").filter({ hasText: "처리 여부 확인 중" });
  await expect(checking).toContainText(NETWORK_ERROR);
  await expect(registerSheet(admin).getByRole("textbox", { name: /^이름/ })).toHaveValue("유실직원");
  await expect(registerSheet(admin).getByRole("button", { name: /^등록하고 닫기/ })).toBeDisabled();
  await admin.keyboard.press("Enter");
  expect(creates.count()).toBe(1);
  await expectAccessible(admin, "register employee: a lost answer");
  const key = [...creates.keys()][0]!;
  const outcome = checking.getByRole("link", { name: "요청 결과 보기", exact: true });
  await expect(outcome).toHaveAttribute("href", `/requests/${key}`);
  await outcome.click();
  await expect(admin.getByRole("status").filter({ hasText: /^반영됨$/ })).toBeVisible();
  await admin.getByRole("link", { name: /^바뀐 곳 보기 ·/ }).first().click();
  await expect(admin.getByRole("heading", { name: /유실직원/, level: 1 })).toBeVisible();
  await expect(admin.getByRole("heading", { level: 1 }).locator("..")).toContainText("CH-0001");
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: "본사" })).toBeVisible(); // the head's 소속, not the placement history's same link
  expect(creates.keys().size).toBe(1);
  expect(creates.count()).toBe(1);
  expect(await named("유실직원")).toHaveLength(1);

  // 「등록하고 다음 사람」 pressed twice on a 5 s answer: one person, and the sheet is ready for the next.
  await go(admin, "/people/new");
  await fillRegister(admin, { name: "느린직원", number: "CH-0002", unit: "인사팀", hired: kstDate() });
  const again = sent(admin, /\/api\/v1\/employees$/);
  await faultNext(admin, /\/api\/v1\/employees$/, "slow");
  await registerSheet(admin).getByRole("button", { name: /^등록하고 다음 사람/ }).dblclick();
  await expect(receiptOf(admin, "느린직원")).toBeVisible({ timeout: 15_000 });
  await expect(registerSheet(admin).getByRole("textbox", { name: /^이름/ })).toHaveValue("");
  test.info().annotations.push({ type: "sends", description: `register double press: ${again.count()} POST, ${again.keys().size} key` });
  expect(again.keys().size).toBe(1);
  expect(await named("느린직원")).toHaveLength(1);
});

/** A roster workbook up to its dry run: the next press is 「명부 반영」, bound to that dry run (BW-10). */
async function dryRun(admin: Page, company: string, file: string, rows: string[][]) {
  await go(admin, "/people"); // a fresh import screen, not the last one's report
  await go(admin, "/people/import");
  await chooseWorkbook(admin, file, await rosterXlsx(company, rows));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
}

test("import on a bad connection: an apply whose answer is lost is not applied twice and says it is done", { tag: "@chaos" }, async ({ browser }) => {
  const admin = await setupTenant(browser, "chaosimp", "혼돈이관");
  const read = apiAs(admin);
  const count = async () => (await read<Page_>("/api/v1/employees?limit=50")).total;
  const upload = (file: string, rows: string[][]) => dryRun(admin, "혼돈이관", file, rows);
  const apply = admin.getByRole("button", { name: "명부 반영" });
  const done = admin.getByRole("heading", { name: "반영했습니다" });

  // The server applies it, the answer is lost: the screen reads the run again and follows the job to done (r3:hire-02),
  // never offering the apply a second time.
  await upload("roster.xlsx", [["IM-0001", "이관일", "인사팀", "사원", "2025-04-01"], ["IM-0002", "이관이", "인사팀", "사원", "2025-04-01"]]);
  await faultNext(admin, /\/import\/[^/]+\/apply$/, "lost");
  await apply.click();
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(admin.getByRole("alert").filter({ hasText: NETWORK_ERROR })).toHaveCount(0);
  await expectAccessible(admin, "import: done after a lost answer");
  expect(await count()).toBe(2);

  // Pressed twice on a 5 s answer: one apply.
  await upload("roster-2.xlsx", [["IM-0003", "이관삼", "인사팀", "사원", "2025-04-01"]]);
  await faultNext(admin, /\/import\/[^/]+\/apply$/, "slow");
  await apply.dblclick();
  await expect(done).toBeVisible({ timeout: 15_000 });
  await expect(admin.getByRole("alert")).toHaveCount(0);
  expect(await count()).toBe(3);
});

// Rows are matched by 사번 (IMPORT BW-10's per-row plan), never by file name and row number: another roster saved
// under the same file name adds its people and leaves the earlier ones as they are.
test("a second roster under the same file name adds its people and leaves the earlier ones as they are", { tag: "@chaos" }, async ({ browser }) => {
  const admin = await setupTenant(browser, "chaosname", "같은파일");
  const read = apiAs(admin);
  await dryRun(admin, "같은파일", "roster.xlsx", [["SF-0001", "구월일", "인사팀", "사원", "2025-04-01"]]);
  await admin.getByRole("button", { name: "명부 반영" }).click();
  await expect(admin.getByRole("heading", { name: "반영했습니다" })).toBeVisible();
  await dryRun(admin, "같은파일", "roster.xlsx", [["SF-0002", "시월일", "인사팀", "사원", "2025-05-01"]]);
  await expect(admin.getByRole("button", { name: "명부 반영: 신규 1명 · 갱신 0명" })).toBeVisible();
  await admin.getByRole("button", { name: "명부 반영" }).click();
  await expect(admin.getByRole("heading", { name: "반영했습니다" })).toBeVisible();
  const names = (await read<Page_>("/api/v1/employees?limit=50")).items.map((e) => e.name).sort();
  expect(names).toEqual(["구월일", "시월일"]);
});
