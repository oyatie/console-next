// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay, pasteText } from "./helpers/attendance-records";
import { chooseRadio, go, kstDate, registerEmployee } from "./flows";
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
  const detail = await (await api(`/attendance/people/${person}/month?month=${month}`)).json();
  let rest: { date: string } | undefined;
  for (const restMonth of new Set([month, kstDate(-28).slice(0, 7)])) {
    const planned = restMonth === month ? detail : await (await api(`/attendance/people/${person}/month?month=${restMonth}`)).json();
    rest = planned.days.find((d: { date: string; plan: { kind: string } }) => d.date < kstDate(0) && d.plan.kind !== "WORK" && d.plan.kind !== "NO_SCHEDULE");
    if (rest) {
      await openMonth(admin, restMonth);
      break;
    }
  }
  expect(rest, "a planned past rest day from the month payload").toBeTruthy();
  await cellOf(admin, "윤하준", rest!.date).click();
  await pasteText(admin, "휴");
  await expect(cellOf(admin, "윤하준", rest!.date)).toHaveAttribute("data-look", "refused");
  await expect(admin.getByText("이 날은 이미 휴무입니다", { exact: false }).first()).toBeVisible();
  await pasteText(admin, "9-18");
  await expect(cellOf(admin, "윤하준", rest!.date)).toHaveAttribute("data-look", "draft");
  await pasteText(admin, "휴");
  const preview = await api("/attendance/entries/preview", "POST", { cells: [{ employee_id: person, work_date: rest!.date, value: "휴" }] });
  expect(preview.ok()).toBe(true);
  expect((await preview.json()).cells[0]).toMatchObject({ status: "REFUSED", code: "already_day_off" });
  await admin.getByRole("grid", { name: "월간 근무표" }).focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안/ });
  await expect(save.getByText("이 날은 이미 휴무입니다", { exact: false })).toBeVisible();
  await expect(save.getByText("이 날의 근무 일정과 다른 값입니다", { exact: false })).toHaveCount(0);
  expect(detail.history).toHaveLength(0);
  expect((await (await api(`/attendance/people/${person}/month?month=${rest!.date.slice(0, 7)}`)).json()).history).toHaveLength(0);
  await save.getByRole("button", { name: "닫기", exact: true }).last().click();
  await go(admin, `/attendance?month=${month}`);
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
  expect((await (await api(`/attendance/people/${person}/month?month=${month}`)).json()).history).toHaveLength(0);

  // The day row and its save dock use the same live plan, including before a server preview.
  await go(admin, `/attendance?tab=day&date=${date}`);
  const dayInput = admin.getByRole("textbox", { name: /^윤하준 기록/ });
  await dayInput.fill("휴");
  await expect(dayInput).toHaveAttribute("aria-invalid", "true");
  await expect(admin.getByText("이 날의 근무 일정과 다른 값입니다", { exact: false }).first()).toBeVisible();
  const dayPreviews: string[] = [];
  admin.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/attendance/entries/preview")) dayPreviews.push(request.url());
  });
  await admin.getByRole("button", { name: "저장", exact: true }).click();
  const daySave = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await expect(daySave.getByText("이 날의 근무 일정과 다른 값입니다", { exact: false })).toBeVisible();
  await expect(daySave.getByRole("list", { name: "저장하지 않는 칸 1 · 초안으로 남습니다" })).toBeVisible();
  expect(dayPreviews).toEqual([]);
  await daySave.getByRole("button", { name: "닫기", exact: true }).last().click();
  await dayInput.fill("9-18");
  await expect(dayInput).not.toHaveAttribute("aria-invalid", "true");

  // A correction uses the same current rest-day plan as the grid.
  const recorded = await api("/attendance/entries", "POST", {
    cells: [{ employee_id: person, work_date: rest!.date, value: "9-18" }],
    source: "MANUAL", evidence: { kind: "PAPER_SHEET" },
  }, { "Idempotency-Key": `attgrammar-${Date.now()}-rest` });
  expect(recorded.status()).toBe(201);
  await go(admin, `/attendance?month=${rest!.date.slice(0, 7)}`);
  await admin.reload();
  await cellOf(admin, "윤하준", rest!.date).click();
  await admin.keyboard.press("p");
  await admin.getByRole("complementary", { name: /하루 기록/ }).getByRole("button", { name: "정정", exact: true }).click();
  const correction = admin.getByRole("complementary", { name: "기록 정정" });
  await correction.getByRole("textbox", { name: /^정정할 값/ }).fill("휴");
  await expect(correction.getByText("이 날은 이미 휴무입니다", { exact: false }).first()).toBeVisible();
  await expect(correction.getByText("이 날의 근무 일정과 다른 값입니다", { exact: false })).toHaveCount(0);
  await admin.context().close();
});

test("24 unscheduled drafts are judged again after assigning a schedule", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(600_000);
  const { admin } = await staffedTenant(browser, "attliveplan", "일정초안주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "G-0024", hired: kstDate(-60) });
  const api = apiOf(admin, bearer);
  const people = (await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] };
  const person = people.items.find((p) => p.name === "윤하준")!.id;
  const month = kstDate(-28).slice(0, 7);
  type PlannedDay = { date: string; plan: { kind: string }; entry: { kind: string } | null };
  const readMonth = async () => (await (await api(`/attendance/people/${person}/month?month=${month}`)).json()) as { days: PlannedDay[] };
  const dates = (await readMonth()).days.slice(0, 24).map((d) => d.date);
  expect(dates).toHaveLength(24);
  await go(admin, `/attendance?month=${month}`);
  await cellOf(admin, "윤하준", dates[0]!).click();
  await pasteText(admin, dates.map(() => "=").join("\t"));
  await expect(admin.getByRole("status").filter({ hasText: "저장 안 된 칸 24" })).toContainText("저장 못 함 24");

  await officeSchedule(admin);
  const planned = (await readMonth()).days.filter((d) => dates.includes(d.date));
  const work = planned.filter((d) => d.plan.kind === "WORK");
  const refused = planned.length - work.length;
  expect(work.length).toBeGreaterThan(0);
  await openMonth(admin, month);
  await expect(admin.getByRole("status").filter({ hasText: "저장 안 된 칸 24" })).toContainText(`저장 못 함 ${refused}`);
  const current = await api("/attendance/entries/preview", "POST", { cells: work.map((d) => ({ employee_id: person, work_date: d.date, value: "=" })) });
  expect(current.ok()).toBe(true);
  expect((await current.json()).cells.every((c: { status: string }) => c.status === "OK")).toBe(true);
  await admin.getByRole("grid", { name: "월간 근무표" }).focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 24칸/ });
  await chooseRadio(save, /출근부 \(종이\)/);
  const label = refused ? `${refused}칸 제외하고 ${work.length}칸 저장` : `${work.length}칸 저장`;
  await save.getByRole("button", { name: label, exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: `${work.length}칸을 저장했습니다` })).toBeVisible();
  const saved = (await readMonth()).days.filter((d) => dates.includes(d.date) && d.entry?.kind === "TIMES");
  expect(saved.map((d) => d.date)).toEqual(work.map((d) => d.date));
  await admin.context().close();
});
