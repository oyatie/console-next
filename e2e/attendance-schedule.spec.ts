import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { bearerOf, apiOf, codeOf } from "./helpers/api";
import { draftWeekly, openSchedule } from "./helpers/attendance";
import { chooseRadio, kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { sheet } from "./sheet";

// 근태 S1 (frames A2-*, A12-first-run) from an empty database: the first run, a pattern refused then added, a
// schedule assigned from a future date with the server's preview, cancelled before it starts, and the refusals
// that must keep refusing (each proven to change nothing).
test("근무 일정: first run → pattern → assign with preview → cancel before effect; refusals change nothing", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "attsch", "근무일정주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "A-0001" });
  await registerEmployee(admin, { name: "송재원", number: "A-0002" });
  await openSchedule(admin);

  // A12-first-run: nobody has a schedule; the available pattern action is the only starting path.
  await expect(admin.getByRole("heading", { name: "아직 근태 기록이 없습니다" })).toBeVisible();
  await expect(admin.getByText(/근무 일정이 지정되지 않은 2명/)).toBeVisible();
  await expect(admin.getByRole("button", { name: "일별 열기" })).toHaveCount(0);
  await expect(admin.getByRole("button", { name: "근무 유형 추가" })).toBeEnabled();
  await expectAccessible(admin, "attendance first run");

  // A pattern with too short a break is refused as it is typed (§54), and the primary says why.
  await admin.getByRole("tab", { name: /근무 유형/ }).click();
  let s = await draftWeekly(admin, "공장 주간 08–17", ["08:00", "17:00", "12:00", "12:30"]);
  await expect(s.getByText(/휴게가 부족합니다/).first()).toBeVisible();
  await expect(s.getByRole("button", { name: "공장 주간 08–17 추가" })).toHaveAttribute("aria-disabled", "true");
  // 탄력적 근로시간제 is listed, not offered: it needs a written agreement first.
  await expect(s.getByRole("combobox", { name: /^유형/ }).locator("option", { hasText: "탄력적" })).toBeDisabled();
  for (const day of ["월", "화", "수", "목", "금"]) await s.getByRole("group", { name: day, exact: true }).getByRole("textbox", { name: /^휴게 끝/ }).fill("13:00");
  await expect(s.getByText(/주 평균 40:00/)).toBeVisible();
  await expectAccessible(admin, "pattern sheet filled");
  await s.getByRole("button", { name: "공장 주간 08–17 추가" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "근무 유형을 추가했습니다 · 「공장 주간 08–17」 · 달력에서 범위에 지정하십시오" })).toBeVisible();
  await expect(admin.getByRole("row", { name: /공장 주간 08–17/ })).toContainText("40:00");

  // Assign it to 본사 from the first of next month: the server previews 2 people moving before the primary.
  const next = `${kstDate(40).slice(0, 7)}-01`;
  await admin.getByRole("tab", { name: "달력" }).click();
  await admin.getByRole("button", { name: "이 범위에 근무 일정 지정" }).click();
  s = sheet(admin, "근무 일정 지정");
  await expect(s.getByRole("button", { name: "근무 일정 적용" })).toHaveAttribute("aria-disabled", "true");
  await s.getByRole("combobox", { name: /^근무 유형/ }).selectOption({ label: "공장 주간 08–17" });
  await s.getByRole("textbox", { name: /^적용 시작일/ }).fill(next);
  await chooseRadio(s, /기본 일정/);
  await expect(s.getByText("2명 · 공장 주간 08–17으로(로) 바뀝니다")).toBeVisible();
  await expect(s.getByText("마감된 달 · 해당 없음")).toBeVisible();
  await expectAccessible(admin, "assign sheet with preview");
  await s.getByRole("button", { name: /^2명에게 .+부터 적용$/ }).click();
  await expect(admin.getByRole("status").filter({ hasText: /공장 주간 08–17.+부터 2명에게 적용했습니다/ })).toBeVisible();
  const history = admin.getByRole("region", { name: "이 범위의 일정 이력" });
  await expect(history.getByRole("row", { name: /공장 주간 08–17/ })).toContainText("예정");
  await expectAccessible(admin, "calendar with a scheduled layer");

  // Cancel before it starts: the reason is required, the row stays in history as 취소됨.
  await history.getByRole("button", { name: "공장 주간 08–17 일정 취소" }).click();
  s = sheet(admin, "근무 일정 취소");
  await expect(s.getByRole("button", { name: "적용 전 취소" })).toHaveAttribute("aria-disabled", "true");
  await s.getByRole("textbox", { name: /^취소 사유/ }).fill("적용 시작일을 잘못 선택함");
  await s.getByRole("button", { name: "적용 전 취소" }).click();
  await expect(history.getByRole("row", { name: /공장 주간 08–17/ })).toContainText("취소됨");

  // A layer from today is in effect at once: the screen offers no 취소, and the server refuses one.
  await admin.getByRole("button", { name: "이 범위에 근무 일정 지정" }).click();
  s = sheet(admin, "근무 일정 지정");
  await s.getByRole("combobox", { name: /^근무 유형/ }).selectOption({ label: "공장 주간 08–17" });
  await s.getByRole("textbox", { name: /^적용 시작일/ }).fill(kstDate(0));
  await chooseRadio(s, /기본 일정/);
  await s.getByRole("button", { name: /^2명에게 .+부터 적용$/ }).click();
  const live = history.getByRole("row", { name: /적용 중/ });
  await expect(live).toBeVisible();
  await expect(live.getByRole("button", { name: /일정 취소/ })).toHaveCount(0);
  const api = apiOf(admin, bearer);
  const layers = (await (await api(`/attendance/schedule/layers?scope_kind=WORKPLACE&scope_id=${await scopeId(admin, api)}`)).json()) as { items: { id: string; state: string }[] };
  const inEffect = layers.items.find((l) => l.state === "IN_EFFECT")!;
  const refused = await api(`/attendance/schedule/layers/${inEffect.id}/cancel`, "POST", { reason: "취소 시도" });
  expect([refused.status(), await codeOf(refused)]).toEqual([409, "schedule_layer_in_effect"]);
  await expect(live).toContainText("적용 중");

  // The pattern now decides 2 people today, so it cannot be retired; the refusal names the fix, nothing changes.
  await admin.getByRole("tab", { name: /근무 유형/ }).click();
  await admin.getByRole("button", { name: "공장 주간 08–17 사용 중지" }).click();
  await expect(admin.getByText(/이 근무 유형을 따르는 범위가 있어 사용 중지할 수 없습니다/)).toBeVisible();
  await expect(admin.getByRole("row", { name: /공장 주간 08–17/ })).toContainText("사용 중");
});

/** The selected scope's id, read from the URL the calendar keeps (`?kind=WORKPLACE&id=…`) or the tree's first workplace. */
async function scopeId(admin: Page, api: ReturnType<typeof apiOf>) {
  const fromUrl = new URL(admin.url()).searchParams.get("id");
  if (fromUrl) return fromUrl;
  const tree = (await (await api("/attendance/schedule/tree")).json()) as { nodes: { kind: string; id: string }[] };
  return tree.nodes.find((n) => n.kind === "WORKPLACE")!.id;
}
