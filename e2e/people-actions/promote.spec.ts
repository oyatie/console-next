import { addTitle } from "../helpers/titles";
import { todayPreset } from "../sheet";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { OUT, shot, VIEW } from "../parity/shot";

// Always at the mockups' 1440 × 900 (@regression: at that width the job-titles list jumped under its add form and the
// bulk page's reason and accept-all controls grew under the pointer); with PARITY_OUT it also draws E6-promote.
test.use(OUT ? VIEW : { viewport: VIEW.viewport });

// 일괄 승진 (spec E6-promote) from an empty company: the 직위 list made on its page (no seeds), three people picked; each
// is offered the next title above theirs, applied only when accepted (no default); a person not yet given a title holds
// the commit back with the gap named. Accepted all at once, the batch records each person's own title.
// @regression: the people table held no rows while the picked records were read, then grew 41 → 164 px under the
// pointer (a control shift on /people/bulk); the rows are now held blank until they land.


test("bulk promotion: a suggestion per person, never applied until accepted; the gap blocks; each person's own title is recorded", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await staffedTenant(browser, "proco", "승진주식회사");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/job-titles");
  for (const [label, rank] of [["사원", "1"], ["주임", "2"], ["대리", "3"]] as const) await addTitle(admin, label, rank);
  const people = [["김사원", "사원"], ["이주임", "주임"], ["박사원", "사원"]] as const;
  for (const [i, [name, position]] of people.entries()) await registerEmployee(admin, { name, number: `PR-000${i + 1}`, position });

  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("");
  await find.press("Enter");
  for (const [name] of people) await admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 3명 일괄 발령" }).click();
  await admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "승진" }).click();

  // Each row offers the next title; nothing is chosen until accepted.
  await expect(admin.getByRole("combobox", { name: "김사원의 새 직위" })).toHaveValue("");
  await expect(admin.getByRole("combobox", { name: "김사원의 새 직위" })).toContainText("주임 제안");
  await expect(admin.getByRole("combobox", { name: "이주임의 새 직위" })).toContainText("대리 제안");
  // One picked by hand, the rest still open: the commit names the gap and records nothing.
  await admin.getByRole("combobox", { name: "박사원의 새 직위" }).selectOption({ label: "대리" });
  await todayPreset(admin).click();
  await admin.getByRole("radiogroup", { name: /^사유/ }).getByRole("radio").first().locator("xpath=ancestor::label[1]").click();
  await admin.getByRole("textbox", { name: /^메모/ }).fill("정기 승진");
  await admin.getByRole("button", { name: /^3명 승진 · 오늘 반영/ }).click();
  await expect(admin.getByRole("alert").filter({ hasText: "새 직위를 선택하지 않은 사람이 2명 있습니다" })).toBeVisible();
  const events = async (name: string) => {
    const id = ((await (await api(`/employees?search=${encodeURIComponent(name)}&limit=1`)).json()) as { items: { id: string }[] }).items[0]!.id;
    return ((await (await api(`/employees/${id}/lifecycle-events`)).json()) as { items: { event_type: string; to_position?: string; to_job_title_id?: string }[] }).items.filter((e) => e.event_type === "PROMOTE");
  };
  expect(await events("김사원")).toHaveLength(0);
  // At the API a promotion with no title is the same refusal, and still nothing is recorded.
  const ids = ((await (await api(`/employees?search=${encodeURIComponent("김사원")}&limit=1`)).json()) as { items: { id: string }[] }).items.map((x) => x.id);
  const bare = await api("/employees/lifecycle-events/bulk", "POST", { event_type: "PROMOTE", employee_ids: ids, effective_date: new Date().toISOString().slice(0, 10), comment: "x" }, { "Idempotency-Key": crypto.randomUUID() });
  expect(bare.status()).toBe(422);
  expect(await codeOf(bare)).not.toBeNull();
  expect(await events("김사원")).toHaveLength(0);
  await expectAccessible(admin, "E6-promote: suggestions offered");
  if (OUT) await shot(admin, "E6-promote");

  // Accept the two suggestions at once; each person's own title is recorded.
  await admin.getByRole("button", { name: "제안 2개 모두 받기" }).click();
  await admin.getByRole("button", { name: /^3명 승진 · 오늘 반영/ }).click();
  await expect(admin.getByRole("status").filter({ hasText: /3명 승진/ }).first()).toBeVisible({ timeout: 15_000 });
  expect((await events("김사원"))[0]?.to_position).toBe("주임");
  expect((await events("이주임"))[0]?.to_position).toBe("대리");
  expect((await events("박사원"))[0]?.to_position).toBe("대리");
  const catalog = ((await (await api("/job-titles")).json()) as { items: { id: string; label: string }[] }).items;
  for (const [name, label] of [["김사원", "주임"], ["이주임", "대리"], ["박사원", "대리"]]) {
    expect((await events(name!))[0]?.to_job_title_id).toBe(catalog.find((x) => x.label === label)!.id);
  }
});

