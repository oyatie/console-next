import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { LifecycleEvent } from "./api";
import { employeeWarningText, describeEvent, fmtDay, hrConfirmedTitle, placeText } from "./present";

beforeAll(() => loadCatalog("ko"));

const event = (x: Partial<LifecycleEvent>): LifecycleEvent =>
  ({
    id: "e1",
    employee_id: "p1",
    event_type: "TRANSFER",
    to_status: "ACTIVE",
    state: "APPLIED",
    effective_date: "2026-10-15",
    comment: "사유",
    signoffs: {},
    created_by: "u1",
    created_by_name: "김인사",
    created_at: "2026-10-01T00:00:00Z",
    from_org_unit: "인사부",
    to_org_unit: "채용팀",
    ...x,
  }) as LifecycleEvent;

test("a history entry says whether the action was done, is waiting, was withdrawn or failed on its date", () => {
  expect(describeEvent(event({}), "정하늘")).toMatchObject({ title: "김인사님이 정하늘을 인사부에서 채용팀으로 전보했습니다" });
  const waiting = describeEvent(event({ state: "SCHEDULED" }), "정하늘");
  expect(waiting.title).toBe("김인사님이 정하늘을 채용팀으로 전보하도록 예약했습니다");
  expect(waiting.detail).toContain("시행 예정");
  expect(waiting.state?.label).toBe("효력 예정");
  const cancelled = describeEvent(event({ state: "CANCELLED", cancel_reason: "계획 변경", cancelled_by_name: "박팀장", cancelled_at: "2026-10-02T01:00:00Z" }), "정하늘");
  expect(cancelled.detail).toContain("박팀장님이");
  expect(cancelled.detail).toContain("취소 사유: 계획 변경");
  expect(describeEvent(event({ state: "CANCELLED", superseded_by: "e2" }), "정하늘").detail).toContain("새 예약으로 바뀌었습니다");
  // The server's (localized) reason reads as is; known codes without one read as catalog copy.
  expect(describeEvent(event({ state: "APPLY_FAILED", failure_code: "lifecycle_noop" }), "정하늘").detail).toContain("바뀔 것이 없었습니다");
  expect(describeEvent(event({ state: "APPLY_FAILED", failure_code: "invalid_transition", failure_reason: "휴직 중인 직원만 복직할 수 있습니다." }), "정하늘").detail).toContain("휴직 중인 직원만 복직할 수 있습니다.");
});

test("a scheduled action that took effect reads as applied on its date, credited to who scheduled it", () => {
  const applied = event({ applied_at: "2026-10-15T00:00:05Z", effective_date: "2026-10-15" });
  expect(describeEvent(applied, "정하늘").title).toBe("정하늘이 2026. 10. 15.자로 인사부에서 채용팀으로 전보되었습니다 (예약: 김인사님)");
});

test("the HR confirmation reads as an exit only once the exit applied; a failed one says it did not", () => {
  expect(hrConfirmedTitle("APPLIED")).toBe("exit.event.hrConfirmed");
  expect(hrConfirmedTitle(null)).toBe("exit.event.hrConfirmed"); // legacy case, recorded before event states
  expect(hrConfirmedTitle("SCHEDULED")).toBe("exit.event.hrConfirmed.scheduled");
  expect(hrConfirmedTitle("CANCELLED")).toBe("exit.event.hrConfirmed.scheduled");
  expect(hrConfirmedTitle("APPLY_FAILED")).toBe("exit.event.hrConfirmed.failed");
});

// ICU ko drops the weekday's parentheses once a year is shown; the sentence would read "21일 수입니다".
test("fmtDay keeps the ko weekday in parentheses for another year's date", () => {
  expect(fmtDay("2099-04-21")).toBe("2099년 4월 21일 (화)");
});

test("typed wage warnings name their floor, while same-day notices explain namesakes", () => {
  const wage = employeeWarningText({ code: "pay_below_minimum_wage", employee_ids: [], floor_won: 2156880 });
  expect(wage).toContain("최저임금 미달");
  expect(wage).toContain("2,156,880");
  expect(wage).not.toContain("동명이인");
  expect(employeeWarningText({ code: "same_name_same_hire_date", employee_ids: [] })).toContain("이름과 입사일이 같은 직원");
});

test("placement paths lead with the one 법인명, its 약칭 secondary, whatever the certificate held", () => {
  const entity = { current: { name: "주식회사 가나테크", display_name: "GANATECH" }, workplaces: [], registrations: [] };
  const unit = { id: "u", name: "본사", kind: "SITE" };
  const option = { unit, entity: "주식회사 가나테크", entityRecord: entity, entityId: "e", workplaceId: "w", site: "본사" };
  expect(placeText([unit] as never, option as never)).toBe("주식회사 가나테크 · GANATECH › 본사");
  expect(placeText([unit] as never, { ...option, entityRecord: undefined } as never)).toBe("법인 미확인 › 본사");
});
