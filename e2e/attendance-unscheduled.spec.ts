// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { chooseRadio, go, kstDate, registerEmployee } from "./flows";
import { fillDay, openSchedule } from "./helpers/attendance";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, pastWorkDay } from "./helpers/attendance-records";
import { staffedTenant } from "./setup-flows";
import { sheet } from "./sheet";

test("일정 없음: warning → filtered people → assign one person; month save has contrast", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "attmissing", "일정확인주식회사");
  const bearer = bearerOf(admin);
  for (const [name, number] of [["윤하준", "U-0001"], ["황정우", "U-0002"], ["송재원", "U-0003"]]) {
    await registerEmployee(admin, { name: name!, number: number!, hired: kstDate(-60) });
  }
  await openSchedule(admin);
  await admin.getByRole("link", { name: "일정 없음 3명 보기" }).click();
  await expect(admin).toHaveURL(/unscheduled=(1|true)/);
  await expect(admin.getByRole("button", { name: "일정 없음만" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(3);
  await expect(admin.getByText(/3명 · 정상 0 · 일정 없음 3/)).toBeVisible();
  await expect(admin.getByRole("button", { name: "소정대로 기록", exact: true })).toHaveCount(0);
  await expect(admin.getByRole("list", { name: "기록이 비어 있는 곳" }).getByRole("link", { name: "일정 없음 3명 보기" })).toBeVisible();
  await expectAccessible(admin, "unscheduled people and remedy");

  await admin.getByRole("button", { name: "일정 지정", exact: true }).first().click();
  // With no work patterns yet, the same remedy creates one before assigning this person.
  const pattern = sheet(admin, "근무 유형 추가");
  await pattern.getByRole("textbox", { name: /^이름/ }).fill("사무 일정");
  await pattern.getByRole("combobox", { name: /^유형/ }).selectOption({ label: "통상" });
  await chooseRadio(pattern, /공휴일에 쉼/);
  for (const day of ["월", "화", "수", "목", "금"]) await fillDay(pattern, day, "09:00", "18:00", "12:00", "13:00");
  await pattern.getByRole("button", { name: "사무 일정 추가" }).click();
  const assign = sheet(admin, "근무 일정 지정");
  await assign.getByRole("combobox", { name: /^근무 유형/ }).selectOption({ label: "사무 일정" });
  await assign.getByRole("textbox", { name: /^적용 시작일/ }).fill(kstDate(-40));
  await chooseRadio(assign, /기본 일정/);
  await assign.getByRole("button", { name: /^1명에게 .+부터 적용$/ }).click();
  await expect(admin.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(2);
  await expect(admin.getByText(/3명 · 정상 1 · 일정 없음 2/)).toBeVisible();
  // The filter survives a reload; the server, rather than loaded browser rows, owns the counts.
  await admin.reload();
  await expect(admin.getByRole("button", { name: "일정 지정", exact: true })).toHaveCount(2);

  // A mixed group fills only its missing work record and reports unscheduled skips honestly.
  const api = apiOf(admin, bearer);
  const people = (await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] };
  const { date } = await pastWorkDay(api, people.items.find((p) => p.name === "윤하준")!.id);
  await go(admin, `/attendance?tab=day&date=${date}`);
  await admin.getByRole("button", { name: "소정대로 기록", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "소정대로 1칸" })).toContainText("일정 없음 2");
  await expect(admin.getByRole("status").filter({ hasText: "소정대로 1칸" })).toContainText("본인·마감 0");

  const month = kstDate(0).slice(0, 7);
  await go(admin, `/attendance?month=${month}`);
  await expect(admin.getByRole("grid", { name: "월간 근무표" })).toBeVisible();
  await expectAccessible(admin, "month with unscheduled rows and save shortcut");
  await admin.getByRole("button", { name: "일정 지정", exact: true }).first().click();
  const monthAssign = sheet(admin, "근무 일정 지정");
  await expect(monthAssign).toBeVisible();
  await monthAssign.getByRole("button", { name: "닫기", exact: true }).last().click();
  await admin.getByRole("button", { name: "일정 지정", exact: true }).first().focus();
  await admin.keyboard.press("Enter");
  await expect(monthAssign).toBeVisible();
  await monthAssign.getByRole("button", { name: "닫기", exact: true }).last().click();
  const day = kstDate(0);
  await cellOf(admin, "윤하준", day).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("button", { name: "저장" })).toBeEnabled();
  await expectAccessible(admin, "enabled attendance save shortcut");
});
