// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay, pasteText } from "./helpers/attendance-records";
import { kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

test("grammar refusals explain the input and preserve an empty record", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(600_000);
  const { admin } = await staffedTenant(browser, "attgrammar", "입력검증주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "G-0001", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const people = (await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] };
  const person = people.items.find((p) => p.name === "윤하준")!.id;
  const { month, date } = await pastWorkDay(api, person);
  await openMonth(admin, month);
  for (const [raw, copy] of [
    ["지각", "출근 시각을 입력합니다 (예: 9:40-18)"],
    ["재택 9-18", "재택·교육 구분은 아직 저장할 수 없습니다"],
    ["휴", "이 날의 근무 일정과 다른 값입니다"],
    ["-18", "퇴근 시각만은 아직 저장할 수 없습니다"],
    ["연차", "휴가는 아직 근태 기록에 저장할 수 없습니다"],
  ]) {
    await cellOf(admin, "윤하준", date).click();
    await pasteText(admin, raw!);
    await expect(admin.getByText(copy!, { exact: false }).first()).toBeVisible();
  }
  const detail = await (await api(`/attendance/people/${person}/month?month=${month}`)).json();
  expect(detail.history).toHaveLength(0);
  await admin.context().close();
});
