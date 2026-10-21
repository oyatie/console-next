import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { clickCounter } from "../clicks";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { apiOf, bearerOf, codeOf, headcount } from "../helpers/api";
import { registerSheet } from "../helpers/register";
import { addDepartments } from "../structure-flows";

// 연속 등록 (spec employee-ux E3-run) from an empty database through the UI: one row per person, saved with ⌘↵ into
// the next row, carry chips all off at first, every gap named and focused, a namesake stopping the row until the user
// says who it is, and the setup phase's undo row by row and all at once. The refusals are asserted at the server too
// (status, code, and a read proving nothing was written).

// At the mockups' 1440 × 900 (@regression: there the entry row scrolled sideways, its carried tags overlapped the values
// and the side cards stacked one under another off screen).
test.use({ viewport: { width: 1440, height: 900 } });

const cell = (page: Page, n: number, field: string) => page.getByRole("textbox", { name: `${n}번째 사람 ${field}` });
const save = (page: Page) => page.getByRole("button", { name: /^저장하고 다음 사람/ });

async function fill(page: Page, n: number, p: { name: string; birth?: string; phone: string; place?: boolean; hire?: string; type?: boolean; position?: string; pay?: string }) {
  await cell(page, n, "이름").fill(p.name);
  if (p.birth) await cell(page, n, "생년월일").fill(p.birth);
  if (p.type) await page.getByRole("combobox", { name: `${n}번째 사람 고용형태` }).selectOption({ label: "정규직" });
  if (p.place) {
    // Typed as a person types (a one-shot fill does not open the list).
    await page.getByRole("combobox", { name: `${n}번째 사람 둘 곳` }).pressSequentially("조립1");
    await page.getByRole("option", { name: /조립1팀/ }).first().click();
  }
  if (p.hire) await cell(page, n, "입사일").fill(p.hire);
  await cell(page, n, "휴대전화").fill(p.phone);
  if (p.position) await cell(page, n, "직위").fill(p.position);
  if (p.pay) await cell(page, n, "기본급").fill(p.pay);
}

test("연속 등록: rows saved with ⌘↵, carried values, gaps named, a namesake stops the row, setup undo", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "runco", "연속정밀", false, "아산공장");
  const bearer = bearerOf(admin);
  const api = apiOf(admin, bearer);
  // The 부서 on the org chart (trunk's cs-chart; /setup/org redirects there).
  await go(admin, "/org");
  await addDepartments(admin, "아산공장", ["조립1팀"]);

  const c = clickCounter();
  await go(admin, "/people/new");
  await c.click(registerSheet(admin).getByRole("link", { name: "연속 등록" }));
  await expect(admin.getByRole("heading", { name: "연속 등록", level: 1 })).toBeVisible();
  await expect(cell(admin, 1, "이름")).toBeFocused();
  // Nothing carried, nothing chosen: the chips are off (an empty field cannot be switched on).
  const carry = admin.getByRole("group", { name: /^다음 사람에게도 같은 값 쓰기/ });
  await expect(carry.getByRole("button", { pressed: true })).toHaveCount(0);
  await expectAccessible(admin, "E3-run: empty run");

  // 1. Refused before sending: an empty row names every gap and focuses the first; a 13th month is no date.
  await c.click(save(admin));
  await expect(admin.getByRole("alert").filter({ hasText: "개를 수정해야 등록됩니다" })).toContainText("이름");
  await expect(cell(admin, 1, "이름")).toBeFocused();
  await fill(admin, 1, { name: "하예솔", birth: "1990-13-12", phone: "010-1234-0052", place: true, hire: "2026-10-19", type: true, position: "사원", pay: "3000000" });
  await admin.keyboard.press("ControlOrMeta+Enter");
  await expect(admin.getByRole("alert")).toContainText("생년월일");
  await expect(cell(admin, 1, "생년월일")).toBeFocused();
  expect(await headcount(api)).toBe(0);
  await expectAccessible(admin, "E3-run: gaps named");

  // 2. The first person: ⌘↵ saves and opens the next row; the server's request is kept for the replay checks below.
  await cell(admin, 1, "생년월일").fill("1990-10-12");
  await admin.keyboard.press("ControlOrMeta+Enter");
  await expect(admin.getByRole("row").filter({ hasText: "하예솔" })).toContainText("E-000001");
  await expect(cell(admin, 2, "이름")).toBeFocused();
  await expect(cell(admin, 2, "이름")).toHaveValue("");

  // 3. Carry: a chip reads as the value in the row and, switched on, keeps it for the next people of the run.
  await fill(admin, 2, { name: "서정우", birth: "1991-03-13", phone: "010-1234-0053", place: true, hire: "2026-10-19", type: true, position: "사원", pay: "3000000" });
  c.done("E3-run second person");
  for (const k of [/^둘 곳 조립1팀/, /^입사일 2026-10-19/, /^고용형태 정규직/, /^직위 사원/, /^기본급 3,000,000/]) await c.click(carry.getByRole("button", { name: k }));
  expect(c.done("E3-run carry chips")).toBe(5);
  await expect(carry.getByRole("button", { pressed: true })).toHaveCount(5);
  await admin.keyboard.press("ControlOrMeta+Enter");
  await expect(admin.getByRole("row").filter({ hasText: "서정우" })).toContainText("E-000002");
  await expect(admin.getByText("이어서 쓴 값", { exact: true })).toHaveCount(5);
  await expect(cell(admin, 3, "입사일")).toHaveValue("2026-10-19");
  // Per person now: name, birth date and the phone the server still requires (EMP-UI 1), then ⌘↵ — no click.
  for (const [i, [name, birth]] of ([["문채이", "1992-08-14"], ["남궁별", "1993-01-15"]] as const).entries()) {
    await fill(admin, 3 + i, { name, birth, phone: `010-2000-100${3 + i}` });
    await admin.keyboard.press("ControlOrMeta+Enter");
    await expect(admin.getByRole("row").filter({ hasText: name })).toContainText(`E-00000${3 + i}`);
  }
  expect(c.done("E3-run two more people")).toBe(0);
  // The whole row fits without scrolling sideways; the batch summary sits below the rows.
  const sideways = await admin.getByRole("table", { name: /^연속 등록/ }).evaluate((t) => {
    let e = t.parentElement;
    while (e && getComputedStyle(e).overflowX === "visible") e = e.parentElement;
    return e ? e.scrollWidth - e.clientWidth : 0;
  });
  expect(sideways).toBeLessThanOrEqual(1);
  await expect(admin.getByRole("heading", { name: /^(키|남은 할 일)$/, level: 2 })).toHaveCount(0);
  const rows = (await admin.getByRole("table", { name: /^연속 등록/ }).boundingBox())!;
  const batch = (await admin.getByRole("complementary", { name: "이번 묶음" }).boundingBox())!;
  expect(batch.y).toBeGreaterThanOrEqual(rows.y + rows.height);
  // An edited carried value loses its tag.
  await cell(admin, 5, "직위").fill("주임");
  await expect(admin.getByText("이어서 쓴 값", { exact: true })).toHaveCount(4);
  await cell(admin, 5, "직위").fill("사원");
  expect(await headcount(api)).toBe(4);

  // 4. A namesake (same name and birth date as row 1) stops the row: nothing is written until the user says who.
  await fill(admin, 5, { name: "하예솔", birth: "1990-10-12", phone: "010-1234-0054" });
  await admin.keyboard.press("ControlOrMeta+Enter");
  const dup = admin.getByRole("status").filter({ hasText: "같은 사람일 수 있습니다" });
  await expect(dup).toBeVisible();
  await expect(dup).toContainText("1990-10-●●");
  await expect(dup).not.toContainText("1990-10-12");
  expect(await headcount(api)).toBe(4);
  await expect(admin.getByRole("complementary", { name: "이번 묶음" })).toContainText("중복 의심 1");
  await expectAccessible(admin, "E3-run: namesake");
  // ⌘↵ again before choosing is still refused: no default answer.
  await admin.keyboard.press("ControlOrMeta+Enter");
  expect(await headcount(api)).toBe(4);
  await dup.getByText("다른 사람입니다 · 동명이인으로 등록").click();
  await dup.getByRole("radiogroup", { name: /동명이인으로 등록하는 사유/ }).getByRole("radio").first().locator("xpath=ancestor::label[1]").click();
  const note = dup.getByRole("textbox", { name: /사유 설명/ });
  if (await note.isVisible()) await note.fill("이름과 생년월일만 같은 다른 사람");
  await admin.keyboard.press("ControlOrMeta+Enter");
  await expect(admin.getByRole("row").filter({ hasText: "E-000005" })).toContainText("하예솔");
  expect(await headcount(api)).toBe(5);

  // 5. The server's own guards, asserted at the API with a read proving nothing was written. The body is the one the
  //    row sends (MR-22): the place as unit, 법인, 사업장 and its branch.
  const unit = ((await (await api("/org-units")).json()) as { items: { id: string; name: string }[] }).items.find((u) => u.name === "조립1팀")!;
  const [entity] = ((await (await api("/legal-entities")).json()) as { items: { id: string; current: { name: string }; workplaces: { id: string; default_branch_id: string; current: { name: string } }[] }[] }).items;
  const body = {
    name: "표건우", company: entity!.current.name, site: "아산공장", org_unit_id: unit.id, legal_entity_id: entity!.id, workplace_id: entity!.workplaces[0]!.id,
    home_branch_id: entity!.workplaces[0]!.default_branch_id, employment_type: "REGULAR", phone: "+8210-1234-0055", position: "사원", base_pay_won: 3000000,
    pay_unit: "MONTHLY", hire_date: "2026-10-19", idempotency_key: crypto.randomUUID(),
  };
  const first = await api("/employees", "POST", body);
  expect(first.status(), await first.text()).toBeLessThan(300);
  expect(await headcount(api)).toBe(6);
  const replay = await api("/employees", "POST", body);
  expect(replay.status(), `an exact replay returns the first person: ${await replay.text()}`).toBeLessThan(300);
  expect(((await replay.json()) as { employee: { employee_number: string } }).employee.employee_number).toBe("E-000006");
  const reused = await api("/employees", "POST", { ...body, name: "다른이름" });
  expect([reused.status(), await codeOf(reused)]).toEqual([409, "idempotency_key_reused"]);
  const blank = await api("/employees", "POST", { ...body, name: " ", idempotency_key: crypto.randomUUID() });
  expect(blank.status()).toBe(422);
  const taken = await api("/employees", "POST", { ...body, name: "새사람", employee_number: "E-000002", birth_date: undefined, idempotency_key: crypto.randomUUID() });
  expect([taken.status(), await codeOf(taken)]).toEqual([409, "employee_number_taken"]);
  expect(await headcount(api)).toBe(6);

  // 6. Setup undo: one row, then the rest of the run at once.
  await c.click(admin.getByRole("button", { name: "남궁별 되돌리기" }));
  await expect(admin.getByRole("row").filter({ hasText: "남궁별" })).toContainText("되돌림");
  expect(await headcount(api)).toBe(5);
  await c.click(admin.getByRole("button", { name: "4명 한 번에 되돌리기" }));
  await expect(admin.getByRole("complementary", { name: "이번 묶음" })).toContainText("등록 0");
  // The person made behind the run's back stays: the run undoes only its own rows.
  expect(await headcount(api)).toBe(1);
  // Finishing an untouched row just leaves.
  await admin.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(admin).toHaveURL(/\/people$/);
});
