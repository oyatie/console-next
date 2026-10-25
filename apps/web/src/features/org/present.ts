// How an org change reads: its title, its operations, its history, its rail and the next step it asks of the viewer.
// changeTitle may move to reference/org/present.ts when the tree (W0) needs it too.
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { APPROVAL_ROLE, ORG_CHANGE_STATUS, UNIT_KIND, actor, label, labeled } from "../../lib/labels";
import { labelTitle, opsTitle, subjectOf, type Names } from "./domain/change-title";
import { todayKst } from "../../lib/pure/today";
import { addDays, daysBetween, nextWeekday } from "../../ui/date/days";

type Detail = components["schemas"]["OrgChangeDetail"];
type Summary = components["schemas"]["OrgChangeSummary"];
type Op = components["schemas"]["OrgProposalOp"];
type Step = components["schemas"]["OrgChangeApprovalStep"];
type Item = components["schemas"]["OrgChangeSettlementItem"];

export { dissolvedName, type Names } from "./domain/change-title";

/**
 * The change as a short phrase, the same in the list, the record and its receipts: what its ops do when it has them
 * (org-25); a list row (no ops) reads the title it was drafted with, else the unit name and the kind verb.
 */
export function changeTitle(c: Summary & { proposal?: Op[] }, n: Names): string {
  const byOps = c.proposal && opsTitle(c.proposal, n);
  if (byOps) return t(`orgChange.title.${byOps.kind}`, byOps.values);
  const name = subjectOf(c, n);
  if (!name) return t("orgChange.title.fallback", { code: c.code });
  const drafted = labelTitle(c, name);
  if (drafted) return drafted;
  if (c.kind === "DISSOLVE" && c.target.kind === "BRANCH") return t("orgChange.title.DISSOLVE.branch", { name });
  return t(`orgChange.title.${c.kind}`, { name });
}

/**
 * My rejected changes still waiting for a redraft: a redraft names the change it replaces (`supersedesId`), so
 * a rejected change no other change of mine supersedes is still mine to act on. `seen` is any other rows on screen:
 * a redraft among them settles its original even while `mine` is an older read.
 */
export const awaitingRedraft = <C extends Summary>(mine: readonly C[], seen: readonly Pick<Summary, "supersedesId">[] = []): C[] => {
  const redrafted = new Set([...mine, ...seen].map((c) => c.supersedesId));
  return mine.filter((c) => c.status === "REJECTED" && !redrafted.has(c.id));
};

const short = (id?: string | null) => (id ? id.slice(0, 8) : "—");

/** One proposal op as a sentence. */
export function describeOp(op: Op, n: Names): string {
  const unit = (id?: string | null) => n.unit(id) ?? short(id);
  const region = (id?: string | null) => n.region(id) ?? short(id);
  switch (op.op) {
    case "CREATE_REGION": return t("org.change.op.CREATE_REGION", { name: op.name });
    case "RENAME_REGION": return t("org.change.op.RENAME_REGION", { region: region(op.regionId), name: op.name });
    case "DEACTIVATE_REGION": return t("org.change.op.DEACTIVATE_REGION", { region: region(op.regionId) });
    case "CREATE_BRANCH": return t("org.change.op.CREATE_BRANCH", { region: region(op.regionId), name: op.name });
    case "RENAME_BRANCH": {
      const v = { branch: n.branch(op.branchId) ?? short(op.branchId), name: op.name, region: op.regionId ? region(op.regionId) : undefined };
      return t(op.name ? (op.regionId ? "org.change.op.RENAME_BRANCH.both" : "org.change.op.RENAME_BRANCH.name") : op.regionId ? "org.change.op.RENAME_BRANCH.region" : "org.change.op.RENAME_BRANCH", v);
    }
    case "DEACTIVATE_BRANCH": return t("org.change.op.DEACTIVATE_BRANCH", { branch: n.branch(op.branchId) ?? short(op.branchId) });
    case "CREATE_SITE": return t("org.change.op.CREATE_SITE", { name: op.name });
    case "UPDATE_SITE": return t("org.change.op.UPDATE_SITE", { name: op.name });
    case "REASSIGN_ORG_UNIT":
      return op.employeeIds
        ? t("orgChange.op.reassignSome", { from: unit(op.fromOrgUnit), to: unit(op.toOrgUnit), count: op.employeeIds.length })
        : t("org.change.op.REASSIGN_ORG_UNIT", { from: unit(op.fromOrgUnit), to: unit(op.toOrgUnit) });
    case "CREATE_ORG_UNIT": return t("org.change.op.CREATE_ORG_UNIT", { kind: label(UNIT_KIND, op.kind), parent: unit(op.parentId), name: op.name });
    case "RENAME_ORG_UNIT": return t("org.change.op.RENAME_ORG_UNIT", { unit: unit(op.orgUnitId), name: op.name });
    case "MOVE_ORG_UNIT": return t("org.change.op.MOVE_ORG_UNIT", { unit: unit(op.orgUnitId), parent: unit(op.parentId) });
    case "DISSOLVE_ORG_UNIT":
      return op.mergedInto ? t("orgChange.op.merge", { unit: unit(op.orgUnitId), into: unit(op.mergedInto) }) : t("org.change.op.DISSOLVE_ORG_UNIT", { unit: unit(op.orgUnitId) });
  }
}

// The change's own event actions (orgchange insert_event), not its audit actions (org_change.*).
const EVENT = {
  create: "orgChange.event.create",
  reschedule: "orgChange.event.reschedule",
  "draft.update": "orgChange.event.update",
  submit: "orgChange.event.submit",
  effectuate: "orgChange.event.effectuate",
  "settlement.complete": "orgChange.event.settle",
  archive: "orgChange.event.archive",
  cancel: "orgChange.event.cancel",
} as const;

/**
 * Timeline wording: who did what. `step.decide` carries `<roleKey>:<DECISION>` in its reason. Only a
 * cancellation keeps its reason as detail: the server's create and update reasons are system text (D2).
 */
export function eventTitle(e: components["schemas"]["OrgChangeEvent"]): { title: string; detail?: string } {
  const who = actor(e.actorName);
  if (e.action === "step.decide" && e.reason) {
    const [role = "", decision = ""] = e.reason.split(":");
    if (decision === "APPROVED" || decision === "REJECTED")
      return { title: t(decision === "APPROVED" ? "orgChange.event.approved" : "orgChange.event.rejected", { actor: who, role: label(APPROVAL_ROLE, role) }) };
  }
  // decisions #26: under approval.policy none a submit records (and applies or schedules) the change; nothing is submission.
  if (e.action === "submit" && e.reason === "approval.policy=none") return { title: t("orgChange.event.recorded", { actor: who }) };
  if (e.action === "cancel" && e.fromStatus === "APPROVED") return { title: t("orgChange.event.unschedule", { actor: who }), detail: e.reason };
  if (e.action === "effectuate.refused") return { title: t("orgChange.event.refused"), detail: e.reason };
  const id = EVENT[e.action as keyof typeof EVENT] as (typeof EVENT)[keyof typeof EVENT] | undefined;
  const detail = e.action === "cancel" ? e.reason : undefined;
  const date = e.action === "reschedule" ? fmtDate(e.reason?.replace("effectiveDate=", "") ?? "") : undefined;
  if (id) return { title: t(id, { actor: who, date }), detail };
  return { title: t("orgChange.event.other", { actor: who, what: e.toStatus ? labeled(ORG_CHANGE_STATUS, e.toStatus).label : e.action }), detail };
}

// the chain is the server's fixed hr → finance → legal → executive; read it from the change once routes exist (BW-01).
const CHAIN = 4;

/**
 * The lifecycle rail. A change that goes through approval (it has steps): draft, approval n/4, approved, applied. Without
 * approval (decisions #26, the pilot default) there is no approval step: written, scheduled for its date, applied. A legacy
 * dissolution stored before org-05 still shows its settlement. No fake precheck step (D6).
 */
export function changeRail(d: Detail): { steps: { key: string; label: string }[]; current: string; failed: boolean } {
  const routed = d.approvalSteps.length > 0 || d.status === "IN_APPROVAL" || d.status === "REJECTED";
  const total = d.approvalSteps.length || CHAIN;
  const approved = d.approvalSteps.filter((s) => s.decision === "APPROVED").length;
  const settled = d.settlementItems.filter((i) => i.done).length;
  const date = fmtDate(d.effectiveDate);
  const submitted = d.events.find((e) => e.action === "submit")?.at ?? d.createdAt;
  const scheduled = d.status === "APPROVED" || d.effectiveDate > todayKst(new Date(submitted));
  const applies = d.applies_at ? fmtDateTime(d.applies_at) : date;
  const steps = [
    { key: "draft", label: t(d.status === "CANCELLED" ? "orgChange.rail.cancelled" : routed ? "orgChange.rail.draft" : "orgChange.rail.recorded") },
    ...(routed
      ? [
          { key: "approval", label: t(d.status === "REJECTED" ? "orgChange.rail.rejected" : "orgChange.rail.approval", { n: approved, total }) },
          { key: "approved", label: t("orgChange.rail.approved") },
        ]
      : scheduled ? [{ key: "approved", label: t("orgChange.rail.scheduled", { date }) }] : []),
    { key: "applied", label: d.status === "APPROVED" ? t("orgChange.rail.ready", { date: applies }) : t("orgChange.rail.applied", { date }) },
    ...(d.settlementItems.length > 0
      ? [
          { key: "settling", label: t("orgChange.rail.settling", { n: settled, total: d.settlementItems.length }) },
          { key: "archived", label: t("orgChange.rail.archived") },
        ]
      : []),
  ];
  const current = { DRAFT: "draft", PRECHECKED: "draft", CANCELLED: "draft", IN_APPROVAL: "approval", REJECTED: "approval", APPROVED: routed ? "applied" : "approved", APPLIED: "applied", SETTLING: "settling", ARCHIVED: "archived" }[d.status];
  return { steps, current, failed: d.status === "REJECTED" || d.status === "CANCELLED" };
}

/** What the viewer can do next on this change (the next-step card). The server re-checks every command. */
export type NextStep =
  | { kind: "submit" }
  | { kind: "draftReadOnly" }
  | { kind: "decide"; step: Step; n: number; total: number; next?: Step; prev?: Step; prevByMe: boolean }
  | { kind: "awaitDecision"; step: Step; drafter: boolean }
  | { kind: "scheduled"; days: number; canTouch: boolean }
  | { kind: "awaitApply" }
  | { kind: "settle"; open: Item[]; canArchive: boolean }
  | { kind: "redraft"; step?: Step }
  | { kind: "rejected"; step?: Step }
  | { kind: "applied" }
  | { kind: "archived" }
  | { kind: "cancelled" };

type Feature = "org_change_draft" | "org_change_approve" | "org_change_apply";
export function nextStep(d: Detail, ctx: { me?: string; can: (f: Feature) => boolean; today: string; routed?: boolean }): NextStep {
  const rejectedAt = d.approvalSteps.find((s) => s.decision === "REJECTED");
  switch (d.status) {
    case "DRAFT":
    case "PRECHECKED":
      return ctx.can("org_change_draft") ? { kind: "submit" } : { kind: "draftReadOnly" };
    case "IN_APPROVAL": {
      const i = d.approvalSteps.findIndex((s) => s.decision === "PENDING");
      const step = d.approvalSteps[i]!;
      const drafter = d.draftedBy === ctx.me;
      if (!ctx.me || drafter || !ctx.can("org_change_approve")) return { kind: "awaitDecision", step, drafter };
      const prev = d.approvalSteps[i - 1];
      return { kind: "decide", step, n: i + 1, total: d.approvalSteps.length, next: d.approvalSteps[i + 1], prev, prevByMe: !!prev && prev.decidedBy === ctx.me };
    }
    case "APPROVED": {
      // org-02: a scheduled change applies by itself at the time served by its settings and can be moved or cancelled before it;
      // under approval.policy none (decisions #26) whoever may propose it may, under routing only an applier.
      const canTouch = ctx.can("org_change_apply") || (!ctx.routed && ctx.can("org_change_draft"));
      const days = daysBetween(ctx.today, d.effectiveDate);
      return days > 0 || canTouch ? { kind: "scheduled", days, canTouch } : { kind: "awaitApply" };
    }
    case "SETTLING": {
      const open = d.settlementItems.filter((i) => !i.done);
      return { kind: "settle", open, canArchive: ctx.can("org_change_apply") };
    }
    case "REJECTED":
      return ctx.can("org_change_draft") ? { kind: "redraft", step: rejectedAt } : { kind: "rejected", step: rejectedAt };
    case "APPLIED": return { kind: "applied" };
    case "ARCHIVED": return { kind: "archived" };
    case "CANCELLED": return { kind: "cancelled" };
  }
}

/** Effective-date presets, the immediate value last: the first working day of next month, next Monday, today. */
export function datePresets(today: string): { label: string; date: string }[] {
  const firstOfNext = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  return [
    { label: t("orgChange.date.nextMonth"), date: nextWeekday(firstOfNext) ?? firstOfNext },
    { label: t("orgChange.date.nextMonday"), date: addDays(today, ((8 - day) % 7) || 7) },
    { label: t("orgChange.date.today"), date: today },
  ];
}

/**
 * What a submit did, in words. With approval (`approval.policy.org_structure = route`) the HR step is next; without it
 * (decisions #26, the pilot default) today's change applied at once and a later one is scheduled for its date.
 */
export function submittedText(d: Pick<Detail, "code" | "kind" | "effectiveDate">, title: string, routed: boolean, today: string) {
  if (routed) return t("orgChange.receipt.submitted", { title, code: d.code, role: label(APPROVAL_ROLE, "hr") });
  if (d.effectiveDate && d.effectiveDate > today) return t("orgChange.receipt.scheduled", { title, code: d.code, date: fmtDate(d.effectiveDate) });
  return t("orgChange.receipt.applied", { title, code: d.code });
}

/** The draft's submit button and what pressing it does: submit into approval, or (decisions #26) apply now / on its effective date. */
export function submitWords(d: Pick<Detail, "effectiveDate">, routed: boolean, today: string) {
  if (routed) return { consequence: t("orgChange.next.draft.consequence") };
  const later = Boolean(d.effectiveDate && d.effectiveDate > today);
  return {
    consequence: [later ? t("orgPropose.consequence.directDated", { date: fmtDate(d.effectiveDate) }) : t("orgPropose.consequence.direct"), t("orgPropose.consequence.directUndo")].join(" "),
  };
}
