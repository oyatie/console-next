// How people's lifecycle events and exit steps read: codes to message ids and words.
import type { components } from "@console/api/schema";
import { isMessageId, t, type MessageId } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtKrw } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, LEAVE_TYPE, LIFECYCLE_EVENT, LIFECYCLE_STATE, actor, codeText, label, labeled, type Labeled } from "../../lib/labels";
import { phoneDisplay } from "../../lib/pure/formats";
import type { ChangeRequest, LifecycleEvent } from "./api";
import { FIELDS, type Field } from "./domain/corrections";
import type { Kind, Row } from "./domain/bulk";
import { reasonLabel } from "../../lib/reason-codes";
import { continuityShape } from "./domain/group-transfer";
import { daysBetween, type VerbWhy } from "./domain/lifecycle";
import { tenure, type NextItem } from "./domain/roster";
import { retirementDate } from "./domain/employment";
import type { PlaceOption } from "./domain/register-place";
import { entityNameText } from "../../reference/entity/present";
import { unitPath } from "../../reference/org/present";
import { domainText, levelText } from "../../reference/authz/present";

export const placeEntityText = (o: PlaceOption) => o.entityRecord ? entityNameText(o.entityRecord) : t("entity.name.unconfirmed");
export const placeText = (units: components["schemas"]["OrgUnitHead"][], o: PlaceOption) => [placeEntityText(o), unitPath(units, o.unit)].join(t("uiChoice.pathSeparator"));

type NextEvent = NonNullable<components["schemas"]["Employee"]["next_event"]>;
type Case = components["schemas"]["EmployeeExitCase"];

/** The nearest scheduled action as "<action> · <date>". */
export const nextEventText = (n: NextEvent) => t("people.nextEvent.value", { action: label(LIFECYCLE_EVENT, n.event_type), date: fmtDate(n.event_type === "TERMINATE" ? retirementDate(n.effective_date) : n.effective_date) });

/** A transfer's or promotion's reason code (or a rescission's) in words, before the note. */
const coded = (x: LifecycleEvent, comment: string) => {
  const domain = x.event_type === "TRANSFER" ? "lifecycle_transfer" : x.event_type === "PROMOTE" ? "lifecycle_promote" : "lifecycle_cancel";
  return x.reason_code ? `${reasonLabel(domain, x.reason_code)} · ${comment}` : comment;
};

/**
 * How the history tells one event: who did what (scheduled or done), when it applies, and its outcome. `byId` finds
 * the record a correction or rescission names (BW-11), and the record that voided this one.
 */
export function describeEvent(x: LifecycleEvent, name: string, byId: (id: string) => LifecycleEvent | undefined = () => undefined): { title: string; detail: string; state?: Labeled } {
  const v = {
    actor: actor(x.created_by_name),
    name,
    from: x.from_org_unit ?? "—",
    to: x.to_org_unit ?? "—",
    fromPosition: x.from_position ?? "—",
    toPosition: x.to_position ?? "—",
    returnDate: fmtDate(x.expected_return_date),
    endDate: fmtDate(x.contract_end_date),
    fromCompany: x.from_company ?? "—",
    toCompany: x.to_company ?? "—",
  };
  const comment = coded(x, commentText(x.comment, x.comment_code));
  const date = fmtDate(x.event_type === "TERMINATE" || x.event_type === "OFFBOARD" ? retirementDate(x.effective_date) : x.effective_date);
  if (x.event_type === "RESCIND") {
    const voided = x.voids_event_id ? byId(x.voids_event_id) : undefined;
    return { title: t("people.event.RESCIND", { ...v, action: voided ? label(LIFECYCLE_EVENT, voided.event_type) : "—", date }), detail: t("people.event.detail", { date, comment }) };
  }
  // Applied events read as done; the rest were scheduled (and are pending, withdrawn or failed).
  const scheduledKinds = ["TRANSFER", "GROUP_TRANSFER", "PROMOTE", "LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE", "CONTRACT_RENEWAL", "TERMINATE"] as const;
  const kind = scheduledKinds.find((k) => k === x.event_type);
  if (x.state !== "APPLIED" && kind) {
    const detail =
      x.state === "SCHEDULED" ? t("people.event.detail.scheduled", { date, comment })
      : x.state === "CANCELLED"
        ? x.superseded_by
          ? t("people.event.detail.superseded", { date, comment })
          : t("people.event.detail.cancelled", { date, actor: actor(x.cancelled_by_name), at: fmtDateTime(x.cancelled_at), reason: x.cancel_reason ?? "—" })
      : t("people.event.detail.failed", { date, reason: failureReason(x) });
    return { title: t(`people.event.scheduled.${kind}`, v), detail: x.leave_type && labeled(LEAVE_TYPE, x.leave_type).code ? `${detail} · ${label(LEAVE_TYPE, x.leave_type)}` : detail, state: labeled(LIFECYCLE_STATE, x.state) };
  }
  // A scheduled action that took effect did so on its date, by the scheduler: the recorder only scheduled it.
  const title =
    kind && x.applied_at ? t(`people.event.applied.${kind}`, { ...v, date })
    : t(x.event_type === "LEAVE_OF_ABSENCE" && x.expected_return_date ? "people.event.LEAVE_OF_ABSENCE.return" : `people.event.${x.event_type}`, v);
  const group = x.group_transfer;
  const base = x.leave_type
    ? t("people.event.detail.leave", { date, type: label(LEAVE_TYPE, x.leave_type), comment })
    : group ? groupDetail(group, { date, consent: fmtDate(group.consent_date), comment })
    : t("people.event.detail", { date, comment });
  const detail = x.voids_event_id ? `${base} · ${t("people.event.detail.correction")}` : base;
  if (x.voided_by) {
    const by = byId(x.voided_by);
    return { title, detail, state: { label: t(by?.event_type === "RESCIND" ? "people.event.state.rescinded" : "people.event.state.corrected"), tone: "neutral" } };
  }
  return { title, detail };
}

/**
 * Why a scheduled event could not apply: the server's reason (localized like any error message), else
 * catalog copy for the known codes.
 */
const failureReason = (x: LifecycleEvent) => {
  if (x.failure_reason) return x.failure_reason;
  const known = ["invalid_transition", "lifecycle_noop", "conflict", "validation"] as const;
  const code = known.find((k) => k === x.failure_code);
  return code ? t(`people.event.failure.${code}`) : (x.failure_code ?? "—");
};

/**
 * How the history tells the HR confirmation: it exited the employee (applied, or a legacy case with no
 * event state), scheduled the exit (pending or later withdrawn), or scheduled one that failed to apply.
 */
export const hrConfirmedTitle = (state: Case["exit_event_state"]) =>
  state === "APPLY_FAILED" ? "exit.event.hrConfirmed.failed"
  : state === "SCHEDULED" || state === "CANCELLED" ? "exit.event.hrConfirmed.scheduled"
  : "exit.event.hrConfirmed";

/** Shrink-only compatibility for the one legacy system sentence; new writers use codes. */
export const LEGACY_SYSTEM_COMMENTS = { "Created through People & Workforce": "created_by_registration" } as const;
export function commentText(comment: string | null | undefined, code?: string | null) {
  const system = code ?? (comment && Object.hasOwn(LEGACY_SYSTEM_COMMENTS, comment) ? LEGACY_SYSTEM_COMMENTS[comment as keyof typeof LEGACY_SYSTEM_COMMENTS] : undefined);
  return system === "created_by_registration" ? t("person.event.systemComment.created") : comment ?? "";
}

/** A business date in sentences and the next box, with its weekday. */
export const fmtDay = (d: string) => fmtDate(d, { weekday: "short" });
/** A business date without a weekday. */
export const fmtDayShort = (d: string) => fmtDate(d);
/** The history gutter uses the same full business-date format as every other surface. */
export const fmtGutter = (d: string, _today: string) => fmtDate(d, { weekday: "short" });
/** Distance from today, in the date field's words: D-n, today, n days ago. */
export const fmtRel = (d: string, today: string) => relDays(daysBetween(today, d));

/** Why some verbs are unavailable, as one line naming them all (transfer and promotion: not while on leave). */
export const whyText = (why: VerbWhy, verbs: readonly string[]) =>
  t(`person.verb.why.${why.kind}`, { verbs: verbs.join("·"), date: why.kind === "exitScheduled" ? fmtDay(why.date) : "" });
/** Calendar days as the date field says them: today, D-n, n days ago. */
export const relDays = (days: number) => (days === 0 ? t("uiDate.today") : days > 0 ? t("uiDate.ahead", { days }) : t("uiDate.ago", { days: -days }));

/** A roster "next" item as text, and its tone (a failure or a contract already over is danger, one ending soon warn). */
export function nextText(i: NextItem): { text: string; tone?: "danger" | "warn" } {
  if (i.kind === "failed") return { text: t("roster.next.failed", { action: label(LIFECYCLE_EVENT, i.event) }), tone: "danger" };
  if (i.kind === "event") return { text: t("roster.next.event", { action: label(LIFECYCLE_EVENT, i.event), date: fmtDate(i.date), rel: relDays(i.days) }) };
  if (i.kind === "return") return { text: t("roster.next.return", { date: fmtDate(i.date), rel: relDays(i.days) }), tone: i.days < 0 ? "warn" : undefined };
  return i.days < 0 ? { text: t("roster.next.expired"), tone: "danger" } : { text: t("roster.next.contract", { rel: relDays(i.days) }), tone: "warn" };
}

/** The hire date with whole years (or months in the first year) served; "starts later" before it. */
export function hiredText(hire: string | null | undefined, today: string) {
  if (!hire) return "—";
  const n = tenure(hire, today);
  const served = !n ? t("roster.tenure.future") : n.years ? t("roster.tenure.years", { years: n.years }) : t("roster.tenure.months", { months: n.months });
  return `${fmtDate(hire)} · ${served}`;
}

// --- BW-17 change requests ---
type Employee = components["schemas"]["Employee"];
const TONE = { OPEN: "warn", APPLIED: "ok", DECLINED: "danger", WITHDRAWN: "neutral" } as const;

export const kindText = (k: ChangeRequest["kind"]) => codeText(`requests.kind.${k}`, k);
/** A request status in words and its tone. */
export const statusOf = (s: ChangeRequest["status"]) => ({ label: t(`requests.status.${s}`), tone: TONE[s] });
/** Who the request is about: the employee's name and number once read (the request carries the id only). */
export const subjectText = (r: ChangeRequest, e?: Employee) =>
  r.subject_type === "EMPLOYEE" ? (e ? `${e.name} (${e.employee_number ?? "—"})` : t("requests.subject.loading")) : codeText(`requests.subject.${r.subject_type}`, r.subject_type);

/** A corrected value as people read it. */
export const valueText = (f: Field, v: unknown) =>
  v == null || v === "" ? "—"
  : f === "phone" ? phoneDisplay(String(v))
  : f === "hire_date" ? fmtDate(String(v))
  : f === "employment_type" ? label(EMPLOYMENT_TYPE, String(v))
  : f === "base_pay" ? fmtKrw(String(v))
  : String(v);

/** The fields a correction request asks to change, in the form's order. */
export const requestedChanges = (r: ChangeRequest) => {
  const c = ((r.payload as { changes?: Record<string, unknown> }).changes ?? {}) as Partial<Record<Field, unknown>>;
  return FIELDS.filter((f) => f in c).map((f) => ({ field: f, value: c[f] }));
};
/** Who a sheet is about, under its title: employee number, unit and position (those on record). */
export const whoLine = (e: { employee_number?: string | null; org_unit?: string | null; position?: string | null }) =>
  [e.employee_number, e.org_unit, e.position].filter(Boolean).join(" · ");
/** A source value of an import as quoted on the unplaced screen (spec E8), or that the file gave none. */
export const sourceText = (v: string) => (v ? t("unplaced.value", { value: v }) : t("unplaced.noValue"));

/** Why a bulk line cannot be recorded, in words. */
export const bulkProblemText = (r: Row, kind: Kind | null): string | undefined => {
  switch (r.problem) {
    case undefined: return undefined;
    // A picked person no longer listed: no employee number was pasted, so say so in roster terms.
    case "notFound": return t(r.line ? "bulk.line.notFound" : "bulk.line.gone");
    case "nameMismatch": return t("bulk.line.nameMismatch", { name: r.employee?.name ?? "" });
    case "unitAmbiguous": return t("bulk.line.unitAmbiguous", { count: r.candidates?.length ?? 0 });
    case "targetMissing": return t(kind === "PROMOTE" ? "bulk.line.targetMissing.PROMOTE" : "bulk.line.targetMissing.TRANSFER");
    default: return t(`bulk.line.${r.problem}`);
  }
};

/** A bulk-correction refusal code in catalog words (the server's message is English and not shown). */
export const refusedText = (code: string) => (isMessageId(`common.failed.code.${code}`) ? t(`common.failed.code.${code}` as never) : t("bulkGrid.rowRefused"));

/**
 * A catalog id built from server codes and field keys (`empRec.education.level.BACHELOR`): the code sets are the
 * server's enums, mirrored in the ko/en catalogs; an id that drifts renders as itself (visible, never a crash).
 */
export const tx = (id: string, values?: Record<string, string | number>) => t(id as MessageId, values);

/** A reservation said as the change it makes: a duty title appointed, a grade promoted; other acts by their name. */
export function plannedWhat(p: LifecycleEvent, title: (id: string | null | undefined) => string | undefined) {
  const to = p.event_type === "APPOINT" ? title(p.to_position_kind_id) : p.event_type === "PROMOTE" ? title(p.to_grade_id) ?? p.to_position : undefined;
  return to ? t(`empCard.next.${p.event_type === "APPOINT" ? "appoint" : "promote"}`, { to }) : label(LIFECYCLE_EVENT, p.event_type);
}

/** What an act changed, as before → after (lead → foreman, team 2 → team 1, childcare leave → back on a date); "" when it names nothing. */
export function eventWhat(x: LifecycleEvent, title: (id: string | null | undefined) => string | undefined) {
  const arrow = (from: string | null | undefined, to: string | null | undefined) => (from || to ? t("empCard.spine.arrow", { from: from || "—", to: to || "—" }) : "");
  const what =
    x.event_type === "APPOINT" ? arrow(title(x.from_position_kind_id), title(x.to_position_kind_id)) || x.to_job || ""
    : x.event_type === "PROMOTE" ? x.to_grade_id ? t("empCard.spine.grade", { change: arrow(title(x.from_grade_id), title(x.to_grade_id)) }) : arrow(x.from_position, x.to_position)
    : x.event_type === "TRANSFER" ? arrow(x.from_org_unit, x.to_org_unit)
    : x.event_type === "GROUP_TRANSFER" ? arrow(x.from_company, x.to_company)
    : x.event_type === "LEAVE_OF_ABSENCE" ? [x.leave_type && label(LEAVE_TYPE, x.leave_type), x.expected_return_date && t("empCard.spine.back", { date: fmtDate(x.expected_return_date) })].filter(Boolean).join(" → ")
    : x.event_type === "EMPLOYMENT_TYPE_CHANGE" ? arrow(x.from_employment_type && label(EMPLOYMENT_TYPE, x.from_employment_type), x.to_employment_type && label(EMPLOYMENT_TYPE, x.to_employment_type))
    : x.event_type === "RETURN_FROM_LEAVE" ? t("empCard.spine.returned", { unit: x.to_org_unit ?? x.from_org_unit ?? "—" })
    : "";
  return what;
}

/** The spine's short line (E2): the act, then what it changed — "appointment · lead → foreman", "transfer · team 2 → team 1". */
export function eventLine(x: LifecycleEvent, title: (id: string | null | undefined) => string | undefined) {
  const what = eventWhat(x, title);
  return what ? t("empCard.spine.line", { act: label(LIFECYCLE_EVENT, x.event_type), what }) : null;
}

/** The field an act changed, as the card names it (unit, grade, duty title, status…); null for an act that is not one field. */
export function eventField(x: LifecycleEvent): string | null {
  const key =
    x.event_type === "TRANSFER" || x.event_type === "GROUP_TRANSFER" ? "unit"
    : x.event_type === "PROMOTE" ? (x.to_grade_id ? "grade" : "position")
    : x.event_type === "APPOINT" ? (x.to_position_kind_id ? "title" : x.to_job_family_id && !x.to_job_id && !x.to_job ? "family" : "job")
    : x.event_type === "EMPLOYMENT_TYPE_CHANGE" ? "type"
    : x.event_type === "LEAVE_OF_ABSENCE" || x.event_type === "RETURN_FROM_LEAVE" || x.event_type === "TERMINATE" ? "status"
    : x.event_type === "ONBOARD" ? "hire"
    : null;
  return key && t(`empCard.f.${key}`);
}
/** UX-R1 PLACEMENT: the people catalog's words for a refusal code (each names the way forward), if it has them. */
export const peopleRefusal = (code: string) => (isMessageId(`exit.error.${code}`) ? t(`exit.error.${code}` as never) : isMessageId(`people.refusal.${code}`) ? t(`people.refusal.${code}` as never) : undefined);

export function employeeWarningText(w: components["schemas"]["EmployeeCreateWarning"]) {
  return w.code === "pay_below_minimum_wage"
    ? `${t("people.warning.pay.title")} · ${t("people.warning.pay.body", { floor: fmtKrw(w.floor_won?.toString()) })}`
    : `${t("people.sameName.chip")} · ${t(w.code === "same_name_same_hire_date" ? "people.sameName.sameHireDate" : "people.sameName.reason")}`;
}

type GroupFacts = NonNullable<LifecycleEvent["group_transfer"]>;

/** A group transfer's history line: one phrase when every dimension went the same way, else each named. */
function groupDetail(g: GroupFacts, v: { date: string; consent: string; comment: string }) {
  const shape = continuityShape(g);
  if (shape !== "MIXED") return t(`people.event.detail.group.${shape}`, v);
  const word = (x: string | undefined) => t(`people.event.group.${x === "CARRIED" ? "CARRIED" : x === "RESTART" ? "RESTART" : "SETTLED"}`);
  return t("people.event.detail.group.MIXED", { ...v, severance: word(g.continuity), leave: word(g.annual_leave_continuity), service: word(g.seniority_continuity) });
}

const TRAIL_REFUSALS = ["lifecycle.refuse.window_not_open", "lifecycle.refuse.self_completion", "lifecycle.refuse.owner_line", "lifecycle.refuse.evidence_required", "lifecycle.refuse.close_blocked", "lifecycle.refuse.deadline_unknown"] as const;
export const lifecycleTrailError = (code: string) => { const id = TRAIL_REFUSALS.find((candidate) => candidate === code); return id ? t(id) : undefined; };
export const trailItemLabel = (id: string | null, fallback: string) => { const known = ["lifecycle.trail.record", "lifecycle.trail.documents", "lifecycle.trail.filing", "lifecycle.trail.accessReview", "lifecycle.trail.documents.hire", "lifecycle.trail.documents.appoint", "lifecycle.trail.documents.leave_start", "lifecycle.trail.documents.leave_return", "lifecycle.trail.documents.contract", "lifecycle.trail.documents.group_transfer_hire"] as const; const key = known.find((candidate) => candidate === id); return key ? t(key) : (id?.startsWith("lifecycle.trail.documents.") || id?.startsWith("enum.checklistItem.")) && isMessageId(id) ? t(id) : fallback; };
export const trailText = (id: string) => isMessageId(id) ? t(id) : id;
export const ownerLabel = (line: string) => { const [domain, level] = line.split("."); return `${domainText(domain ?? "")} ${level === "edit" || level === "approve" ? levelText(level) : level ?? ""}`; };
export const trailGroup = (kind: string) => kind === "FIL" ? "filing" : kind === "PAY" ? "payment" : kind === "ACC" ? "access" : kind === "BACK" ? "return" : "documents";
