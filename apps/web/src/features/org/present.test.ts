import { beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { awaitingRedraft, changeRail, changeTitle, datePresets, eventTitle, nextStep, type Names } from "./present";

type Detail = components["schemas"]["OrgChangeDetail"];
type Step = components["schemas"]["OrgChangeApprovalStep"];

beforeAll(() => loadCatalog("ko"));

const UNIT = "e47d8645-a435-4007-a0eb-6e111067cfe1";
const names: Names = {
  unit: (id) => (id === UNIT ? "채용팀" : undefined),
  region: (id) => (id === "r1" ? "수도권" : undefined),
  branch: (id) => (id === "b1" ? "서면점" : undefined),
};
const step = (n: number, decision: Step["decision"] = "PENDING", decidedBy?: string): Step => ({
  id: `s${n}`,
  stepOrder: n,
  roleKey: (["hr", "finance", "legal", "executive"] as const)[n - 1]!,
  decision,
  decidedBy,
  decidedByName: decidedBy ? "이임원" : null,
});
const change = (x: Partial<Detail>): Detail => ({
  id: "c1",
  code: "OC-2026-0005",
  kind: "DISSOLVE",
  status: "DRAFT",
  target: { kind: "ORG_UNIT", ref: UNIT, label: `OrgUnit ${UNIT}` },
  effectiveDate: "2026-11-02",
  reason: "통합",
  headcount: 2,
  siteCount: 0,
  teamCount: 1,
  draftedBy: "u-admin",
  draftedByName: "김인사",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  proposal: [{ op: "DISSOLVE_ORG_UNIT", orgUnitId: UNIT }],
  approvalSteps: [],
  settlementItems: [],
  events: [],
  ...x,
});

test("a title names the unit, never a raw id (D1)", () => {
  expect(changeTitle(change({}), names)).toBe("채용팀 폐지");
  // The server's label is "OrgUnit <uuid>" and the ref may be free-form: the op's id still resolves.
  expect(changeTitle(change({ target: { kind: "ORG_UNIT", ref: "x", label: `OrgUnit ${UNIT}` } }), names)).toBe("채용팀 폐지");
  // A summary has no proposal: the uuid inside the label resolves.
  expect(changeTitle({ ...change({ target: { kind: "ORG_UNIT", ref: "x", label: `OrgUnit ${UNIT}` } }), proposal: undefined }, names)).toBe("채용팀 폐지");
  // A create's ref is its parent: the new name comes from the op, or from the label.
  expect(changeTitle(change({ kind: "NEW", target: { kind: "ORG_UNIT", ref: UNIT, label: "인재개발팀" }, proposal: [{ op: "CREATE_ORG_UNIT", kind: "TEAM", parentId: UNIT, name: "인재개발팀" }] }), names)).toBe("인재개발팀 신설");
  expect(changeTitle(change({ kind: "DISSOLVE", target: { kind: "BRANCH", ref: "b1", label: "Branch b1" }, proposal: [{ op: "DEACTIVATE_BRANCH", branchId: "b1" }] }), names)).toBe("서면점 폐쇄");
  expect(changeTitle(change({ target: { kind: "ORG_UNIT", ref: "x", label: "OrgUnit 00000000-0000-0000-0000-000000000000" }, proposal: [] }), names)).toBe("조직 변경 OC-2026-0005");
});

test("the rail has no precheck step and counts approvals (D6), and fails where the change ended", () => {
  const r = changeRail(change({ status: "IN_APPROVAL", approvalSteps: [step(1, "APPROVED"), step(2), step(3), step(4)] }));
  expect(r.steps.map((s) => s.label)).toEqual(["초안", "결재 1/4", "승인", "반영 2026. 11. 02."]);
  expect(r.current).toBe("approval");
  const rejected = changeRail(change({ kind: "NEW", status: "REJECTED", approvalSteps: [step(1, "APPROVED"), step(2, "REJECTED"), step(3), step(4)] }));
  expect(rejected).toMatchObject({ current: "approval", failed: true });
  expect(rejected.steps[1]!.label).toBe("결재 1/4 · 반려됨");
  expect(changeRail(change({ status: "PRECHECKED" })).current).toBe("draft");
});

test("without approval (decisions #26) the rail never says 결재 or 승인, and a 폐지 has no tick list (regression: org-03, org-05)", () => {
  const scheduled = changeRail(change({ status: "APPROVED" }));
  expect(scheduled.steps.map((s) => s.label)).toEqual(["작성", "예약 · 2026. 11. 02.", "2026. 11. 02. 00:05 반영"]);
  expect(scheduled.current).toBe("approved");
  const applied = changeRail(change({ status: "APPLIED" }));
  expect(applied.steps.map((s) => s.label).join(" ")).not.toMatch(/결재|승인|기안|상신|정리/);
  expect(applied.current).toBe("applied");
});

test("the next step follows status, rights, the drafter rule and the effective date", () => {
  const all = () => true;
  const steps = [step(1, "APPROVED", "u-exec"), step(2), step(3), step(4)];
  expect(nextStep(change({}), { me: "u-admin", can: all, today: "2026-10-02" }).kind).toBe("submit");
  expect(nextStep(change({}), { me: "u-admin", can: () => false, today: "2026-10-02" }).kind).toBe("draftReadOnly");
  expect(nextStep(change({ status: "IN_APPROVAL", approvalSteps: steps }), { me: "u-admin", can: all, today: "2026-10-02" })).toMatchObject({ kind: "awaitDecision", drafter: true });
  expect(nextStep(change({ status: "IN_APPROVAL", approvalSteps: steps }), { me: "u-exec", can: all, today: "2026-10-02" })).toMatchObject({
    kind: "decide",
    n: 2,
    total: 4,
    prevByMe: true,
    step: { id: "s2" },
    next: { id: "s3" },
  });
  // org-02: a scheduled change can be moved or cancelled by whoever may propose it (no approval), or an applier.
  expect(nextStep(change({ status: "APPROVED" }), { me: "u-admin", can: all, today: "2026-10-02" })).toEqual({ kind: "scheduled", days: 31, canTouch: true });
  const drafterOnly = (f: string) => f === "org_change_draft";
  expect(nextStep(change({ status: "APPROVED" }), { me: "u-admin", can: drafterOnly, today: "2026-10-02" })).toEqual({ kind: "scheduled", days: 31, canTouch: true });
  expect(nextStep(change({ status: "APPROVED" }), { me: "u-admin", can: drafterOnly, today: "2026-10-02", routed: true })).toEqual({ kind: "scheduled", days: 31, canTouch: false });
  expect(nextStep(change({ status: "APPROVED" }), { me: "u-admin", can: all, today: "2026-11-02" })).toEqual({ kind: "scheduled", days: 0, canTouch: true });
  expect(nextStep(change({ status: "APPROVED" }), { me: "u-admin", can: () => false, today: "2026-11-02" }).kind).toBe("awaitApply");
  expect(nextStep(change({ status: "REJECTED", approvalSteps: steps }), { me: "u-admin", can: all, today: "2026-11-02" }).kind).toBe("redraft");
  // Archiving is offered only while settling: never on an applied change (D16).
  expect(nextStep(change({ status: "APPLIED" }), { me: "u-admin", can: all, today: "2026-11-02" }).kind).toBe("applied");
});

test("history drops the server's system reasons except a cancellation's (D2)", () => {
  const e = { at: "2026-10-01T00:00:00Z", actor: "u", actorName: "김인사" };
  expect(eventTitle({ ...e, action: "create", reason: "Dissolve org unit" })).toEqual({ title: "김인사님이 조직 변경을 작성했습니다", detail: undefined });
  // decisions #26: a submit under approval.policy none records the change; nothing is 상신 (regression: org-03).
  expect(eventTitle({ ...e, action: "submit", fromStatus: "DRAFT", toStatus: "APPROVED", reason: "approval.policy=none" }).title).toBe("김인사님이 조직 변경을 기록했습니다");
  expect(eventTitle({ ...e, action: "reschedule", reason: "effectiveDate=2026-11-09" }).title).toBe("김인사님이 시행일을 변경했습니다 · 2026. 11. 09.");
  expect(eventTitle({ ...e, action: "cancel", fromStatus: "APPROVED", reason: "일정 변경" })).toEqual({ title: "김인사님이 예약을 취소했습니다", detail: "일정 변경" });
  expect(eventTitle({ ...e, action: "effectuate.refused", reason: "transfer_cross_entity" })).toEqual({ title: "시행일에 반영하지 못했습니다", detail: "transfer_cross_entity" });
  expect(eventTitle({ ...e, action: "cancel", reason: "중복" })).toEqual({ title: "김인사님이 조직 변경을 취소했습니다", detail: "중복" });
  expect(eventTitle({ ...e, action: "step.decide", reason: "finance:REJECTED" }).title).toBe("김인사님이 재무 결재를 반려했습니다");
  expect(eventTitle({ ...e, action: "submit", toStatus: "IN_APPROVAL" }).title).toBe("김인사님이 조직 변경을 상신했습니다");
});

test("date presets resolve to working days, the immediate value last", () => {
  // 2026-10-02 is a Friday; 1 Nov 2026 is a Sunday.
  expect(datePresets("2026-10-02").map((p) => p.date)).toEqual(["2026-11-02", "2026-10-05", "2026-10-02"]);
});

test("awaitingRedraft: my rejected changes no other change of mine supersedes", () => {
  const mine = [
    change({ id: "a", status: "REJECTED" }),
    change({ id: "b", status: "REJECTED" }),
    change({ id: "b2", status: "DRAFT", supersedesId: "b" }),
    change({ id: "c", status: "IN_APPROVAL" }),
  ];
  expect(awaitingRedraft(mine).map((c) => c.id)).toEqual(["a"]);
  // A redraft on screen settles its original even when `mine` was read before the redraft existed.
  expect(awaitingRedraft(mine, [change({ id: "a2", status: "IN_APPROVAL", supersedesId: "a" })]).map((c) => c.id)).toEqual([]);
});
