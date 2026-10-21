import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, kstDate, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { OUT, shot, VIEW } from "../parity/shot";

// With PARITY_OUT set this journey also draws the mockup frame E6-renew (answered, one refused by the two-year rule).
if (OUT) test.use(VIEW);

// 일괄 계약 갱신 (spec E6-renew, BE-EMP-UI §3) from an empty company: three contract workers picked in the roster, each
// answered with no default. The server checks every renewal first: one near two years of service is refused on its
// row (기간제법 제4조) and nothing is sent; answered again as 무기 전환, the renewal and the conversion are scheduled
// and the one not renewed is handed to an exit report.

test("bulk renewal: no default, the two-year rule refuses one before anything is sent, then renew + convert + exit report", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await staffedTenant(browser, "renco", "갱신주식회사");
  const api = apiOf(admin, bearerOf(admin));
  const people = [
    { name: "오래근", number: "RN-0001", hired: kstDate(-700), contractEnd: kstDate(40) },
    { name: "새로근", number: "RN-0002", hired: kstDate(-100), contractEnd: kstDate(20) },
    { name: "그만근", number: "RN-0003", hired: kstDate(-200), contractEnd: kstDate(30) },
  ];
  for (const p of people) await registerEmployee(admin, p);
  const ids = ((await (await api("/employees?search=근&limit=10")).json()) as { items: { id: string; name: string }[] }).items;
  const idOf = (name: string) => ids.find((x) => x.name === name)!.id;
  const scheduled = async () => (await Promise.all(people.map(async (p) => ((await (await api(`/employees/${idOf(p.name)}/lifecycle-events`)).json()) as { items: { state: string; event_type: string }[] }).items))).flat().filter((e) => e.state === "SCHEDULED").length;

  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("");
  await find.press("Enter");
  for (const p of people) await admin.getByRole("row", { name: new RegExp(p.name) }).locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 3명 계약 갱신" }).click();
  await expect(admin.getByRole("heading", { name: "계약 종료 · 3명", level: 1 })).toBeVisible();

  // Nothing is chosen for anyone: a press names what is missing and sends nothing.
  for (const p of people) await expect(admin.getByRole("combobox", { name: `${p.name}의 계약` })).toHaveValue("");
  // @regression: the contracts table was squeezed into the first of three columns, under the check card; now the table
  // has the room and the card sits beside it, nothing overlapping.
  const table = (await admin.getByRole("region", { name: "일괄 발령 · 계약 갱신" }).boundingBox())!;
  const side = (await admin.getByRole("heading", { name: "확인", exact: true, level: 2 }).boundingBox())!;
  expect(table.x + table.width).toBeLessThanOrEqual(side.x);
  const rows = (await admin.getByRole("table", { name: "일괄 발령 · 계약 갱신" }).boundingBox())!;
  expect(rows.x + rows.width).toBeLessThanOrEqual(table.x + table.width + 1);
  await admin.getByRole("button", { name: /^갱신 0 · 전환 0 예약/ }).click();
  await expect(admin.getByText(/선택하지 않은 줄 3개/)).toBeVisible();
  expect(await scheduled()).toBe(0);

  // Everyone renewed on the same terms, one not renewed; the server refuses the one past two years and nothing is sent.
  await admin.getByRole("group", { name: "선택한 줄에 같은 값" }).getByRole("button", { name: "같은 조건 갱신" }).click();
  await admin.getByRole("combobox", { name: "그만근의 계약" }).selectOption({ label: "갱신하지 않음 → 퇴직" });
  await admin.getByRole("radiogroup", { name: /^같은 조건의 기간/ }).getByText("1년", { exact: true }).click();
  await admin.getByRole("textbox", { name: /^메모/ }).fill("계약 만료 정리");
  await admin.getByRole("button", { name: /^갱신 2 · 전환 0 예약/ }).click();
  await expect(admin.getByRole("alert")).toContainText("1명은 서버가 받지 않습니다");
  await expect(admin.getByRole("row", { name: /오래근/ })).toContainText("2년 · 갱신 불가");
  expect(await scheduled()).toBe(0);
  await expectAccessible(admin, "E6-renew: a renewal refused by the two-year rule");
  if (OUT) await shot(admin, "E6-renew");

  // At the API the same renewal is the same refusal, named per person.
  const direct = await api("/employees/lifecycle-events/bulk", "POST", { event_type: "CONTRACT_RENEWAL", employee_ids: [idOf("오래근")], effective_date: kstDate(41), contract_end_date: kstDate(400), comment: "x" }, { "Idempotency-Key": crypto.randomUUID() });
  expect([direct.status(), await codeOf(direct)]).toEqual([422, "bulk_lifecycle_refused"]);
  expect(await direct.text()).toContain("fixed_term_limit");

  // Answered again as 무기 전환: the renewal and the conversion are scheduled; the one not renewed gets an exit report.
  await admin.getByRole("combobox", { name: "오래근의 계약" }).selectOption({ label: "무기 전환" });
  await admin.getByRole("button", { name: /^갱신 1 · 전환 1 예약/ }).click();
  await expect(admin.getByRole("status").filter({ hasText: "2건을 예약했습니다" })).toBeVisible({ timeout: 15_000 });
  expect(await scheduled()).toBe(2);
  await admin.getByRole("link", { name: "그만근 퇴직 보고" }).click();
  await expect(admin.getByRole("dialog", { name: /퇴직 보고/ })).toBeVisible();
});
