import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth } from "./helpers/attendance-records";
import { chooseRadio, go, kstDate, option, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

const today = kstDate();
const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
const monthName = new Intl.DateTimeFormat("ko-KR", { timeZone: "UTC", year: "numeric", month: "long" }).format(new Date(`${lastMonth}-15T00:00:00Z`));
const LOCKS = "/people/period-locks";

// att-closed-month-unlock (P0): a closed 근태 month refused every write, and an approved period unlock never reopened
// it. Closed is read-only and links to the unlock of the lock behind the close; while unlocked the month takes a save
// and says when it locks again; the early re-lock closes it again. Every refusal is asserted at the server too.
test("마감된 달: read-only with the unlock path, editable while unlocked, closed again on re-lock", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(600_000); // a staffed tenant, a person and a schedule through the UI, then close, unlock, save, re-lock
  const { admin } = await staffedTenant(browser, "attclose", "근태마감주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "C-0001", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const people = (await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] };
  const yoon = people.items.find((p) => p.name === "윤하준")!.id;
  const history = async () => ((await (await api(`/attendance/people/${yoon}/month?month=${lastMonth}`)).json()) as { days: { date: string; plan: { kind: string } }[]; history: unknown[] });
  const date = (await history()).days.filter((d) => d.plan.kind === "WORK").at(-1)!.date;
  const save = (value: string) => api("/attendance/entries", "POST", { cells: [{ employee_id: yoon, work_date: date, value }], source: "MANUAL", evidence: { kind: "PAPER_SHEET" } }, { "Idempotency-Key": `closed-month-${value}-${Date.now()}` });
  const refusedCode = async (value: string) => {
    const res = await save(value);
    const body = (await res.json()) as { error?: { details?: { refused?: { code?: string }[] } } };
    return [res.status(), await codeOf(res), body.error?.details?.refused?.[0]?.code];
  };

  // The month close has no screen in this build (the close tab is its own lane): the one step taken at the API.
  const close = await api("/attendance/closes", "POST", { month: lastMonth, attest: true });
  expect(close.status()).toBe(201);

  // Closed: read-only with the one way to change it; typing leaves no draft, and the server refuses a save.
  const grid = await openMonth(admin, lastMonth);
  const closed = admin.getByText(`${monthName} 근태는 마감되어 읽기만 할 수 있습니다 · 변경하려면 기간 잠금 해제를 요청합니다`);
  await expect(closed).toBeVisible();
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("status").filter({ hasText: "마감된 달은 저장할 수 없습니다" })).toBeVisible();
  await expect(admin.getByRole("status").filter({ hasText: /^저장 안 된 칸 0 ·/ })).toBeVisible();
  expect(await refusedCode("9-18")).toEqual([422, "cells_refused", "entry_month_closed"]);
  expect((await history()).history).toHaveLength(0);
  await expectAccessible(admin, "closed month");
  // Typing in a closed row, then leaving the month (back-navigation): nothing is kept, and the note says why.
  await admin.getByRole("button", { name: "다음 달" }).click();
  await admin.getByRole("button", { name: "이전 달" }).click();
  await expect(closed).toBeVisible();
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-18");
  await admin.goBack();
  await expect(admin.getByRole("status").filter({ hasText: "윤하준의 줄이 화면에서 빠졌습니다 · 마감된 달이라 입력하던 값은 남기지 않았습니다" })).toBeVisible();
  await admin.goForward();
  await expect(closed).toBeVisible();
  await expect(admin.getByRole("status").filter({ hasText: /^저장 안 된 칸 0 ·/ })).toBeVisible();

  // The banner opens this lock's unlock on 기간 잠금: the sole close authority unlocks for one day, flagged for review.
  await admin.getByRole("link", { name: "기간 잠금 해제 요청" }).click();
  const dialog = admin.getByRole("dialog", { name: `급여 ${monthName} 잠금 해제` });
  await option(admin, "해제 사유", "소급 정정").click();
  await dialog.getByLabel("해제 메모").fill("9월 근태 누락분 반영");
  await dialog.getByRole("button", { name: /^1일 동안/ }).click();
  await dialog.getByRole("button", { name: "패스키로 확인하고 잠금 해제" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "잠금을 해제했습니다" })).toBeVisible();

  // Reopened: the banner says until when, and the cell saves with 근거.
  await go(admin, "/attendance");
  await openMonth(admin, lastMonth);
  await expect(admin.getByText(new RegExp(`${monthName} 근태는 기간 잠금 해제로 변경할 수 있습니다 · .+에 다시 잠김`))).toBeVisible();
  await expectAccessible(admin, "reopened month");
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const sheet = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(sheet, /출근부 \(종이\)/);
  await sheet.getByRole("button", { name: "1칸 저장" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
  expect((await history()).history).toHaveLength(1);

  // Re-locked early (one click on 기간 잠금): closed again, at the screen and at the server.
  await go(admin, LOCKS);
  await admin.getByRole("button", { name: "해제됨 1" }).click();
  await admin.getByRole("row", { name: /소급 정정/ }).getByRole("button", { name: `급여 ${monthName} 지금 다시 잠금` }).click();
  await expect(admin.getByRole("status").filter({ hasText: `급여 ${monthName} 기간을 잠갔습니다` })).toBeVisible();
  await go(admin, "/attendance");
  await openMonth(admin, lastMonth);
  await expect(closed).toBeVisible();
  expect(await refusedCode("8-17")).toEqual([422, "cells_refused", "entry_month_closed"]);
  expect((await history()).history).toHaveLength(1);
});
