// Every enum the UI renders goes through here: no raw backend enum strings on screen.
// Words live in the catalog as `enum.<type>.<VALUE>`; tones (presentation) stay here.
import type { components } from "@console/api/schema";
import type * as P from "@console/api/pending";
import { personName } from "../reference/person/present";
import { isMessageId, t } from "@console/i18n";

type S = components["schemas"];
type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
export type Labeled = { label: string; tone?: Tone; code?: string };
export type Enum<V extends string = string> = { type: string; values: readonly V[]; tone?: Partial<Record<V, Tone>>; extensible?: boolean };

const values = <V extends string>(type: string, v: readonly V[]): Enum<V> => ({ type, values: v });
const toned = <V extends string>(type: string, tone: Record<V, Tone>): Enum<V> => ({ type, values: Object.keys(tone) as V[], tone });

export const ROLE = values("role", ["SUPER_ADMIN", "EXECUTIVE", "ADMIN", "MEMBER", "MECHANIC", "RECEPTIONIST"]);
export const ACCOUNT_STATUS = toned<S["AccountStatus"]>("accountStatus", { ACTIVE: "ok", PENDING_SETUP: "warn", ARCHIVED: "neutral" });
export const TENANT_LIFECYCLE = toned("tenantLifecycle", { OPENED: "neutral", CODE_ISSUED: "info", ENROLLED: "info", SETUP: "warn", OPERATING: "ok" });
export const TENANT_STATUS = toned("tenantStatus", { ACTIVE: "ok", SUSPENDED: "warn", ARCHIVED: "neutral" });
export const EMPLOYMENT_TYPE = values<NonNullable<S["EmployeeEmploymentDetail"]["employment_type"]>>("employmentType", ["REGULAR", "CONTRACT", "PART_TIME", "INTERN"]);
export const ORG_CHANGE_KIND = values<S["OrgChangeKind"]>("orgChangeKind", ["NEW", "REORG", "DISSOLVE"]);
export const ORG_HISTORY_ACTION = { ...values("orgHistoryAction", ["org_unit.setup_create", "org_unit.setup_rename", "org_unit.setup_move", "org_unit.setup_dissolve", "org_unit.setup_details", "org_unit.setup_revert", "org_unit.dissolve", "org_unit.details", "CREATE_ENTITY", "REVISE_ENTITY", "CREATE_WORKPLACE", "REVISE_WORKPLACE"]), extensible: true };
export const ORG_CHANGE_STATUS = toned<S["OrgChangeStatus"]>("orgChangeStatus", {
  DRAFT: "neutral",
  PRECHECKED: "info",
  IN_APPROVAL: "info",
  APPROVED: "ok",
  APPLIED: "ok",
  SETTLING: "warn",
  ARCHIVED: "neutral",
  REJECTED: "danger",
  CANCELLED: "neutral",
});
export const ORG_CHANGE_TARGET = values<S["OrgChangeTargetKind"]>("orgChangeTarget", ["ENTITY", "REGION", "BRANCH", "SITE", "ORG_UNIT"]);
export const APPROVAL_ROLE = values<S["OrgChangeApprovalRoleKey"]>("approvalRole", ["hr", "finance", "legal", "executive"]);
export const STEP_DECISION = toned<S["OrgChangeStepDecision"]>("stepDecision", { PENDING: "neutral", APPROVED: "ok", REJECTED: "danger" });
export const SETTLEMENT = values<S["OrgChangeSettlementKey"]>("settlement", [
  "TRANSFER_EMPLOYEES",
  "POSITIONS",
  "COST_CENTERS",
  "CLOSE_OPEN_DOCS",
  "ASSETS",
  "PAYROLL_SOCIAL_FINAL",
]);
export const EMPLOYEE_STATUS = toned<S["EmployeeLifecycleEvent"]["to_status"]>("employeeStatus", { ACTIVE: "ok", PRE_HIRE: "info", ON_LEAVE: "info", EXITED: "neutral", UNKNOWN: "warn" });
export const JOB_TITLE_KIND = values<S["JobTitleKind"]>("jobTitleKind", ["GRADE", "TITLE", "POSITION", "JOB", "JOB_FAMILY"]);
export const UNIT_KIND = values("unitKind", ["COMPANY", "SITE", "DEPARTMENT", "TEAM"]);
export const UNIT_STATUS = toned("unitStatus", { ACTIVE: "ok", DISSOLVED: "neutral" });
export const IMPORT_CLASSIFICATION = toned("importClassification", { canonical: "ok", retained: "neutral", restricted: "warn", location: "info" });
export const IMPORT_TARGET = values<NonNullable<S["EmployeeImportColumn"]["target"]>>("importTarget", [
  "name",
  "employee_number",
  "org_unit",
  "job",
  "position",
  "worksite_name",
  "worksite_address",
  "hire_date",
  "exit_date",
  "leave_accrued",
  "leave_used",
  "leave_remaining",
  "company",
]);
export const EXIT_CASE_STATUS = toned<S["EmployeeExitCaseStatus"]>("exitCaseStatus", {
  REPORTED: "warn",
  HR_CONFIRMED: "info",
  HQ_CONFIRMED: "info",
  SETTLEMENT_READY: "info",
  APPROVAL_DRAFTED: "info",
  SUBMITTED: "ok",
  REJECTED: "danger",
  CANCELLED: "neutral",
});
export const SETTLEMENT_STATUS = toned<S["EmployeeExitSettlementPackage"]["status"]>("settlementStatus", {
  NEEDS_SOURCE: "warn",
  READY_FOR_APPROVAL: "info",
  APPROVAL_DRAFTED: "info",
  SUBMITTED: "ok",
});
/** A lifecycle event's state: effective-dated events wait as SCHEDULED until their date. */
/** The kinds of action an employee's next (scheduled) event can be. */
export const LIFECYCLE_EVENT = values<NonNullable<S["Employee"]["next_event"]>["event_type"]>("lifecycleEvent", ["TRANSFER", "PROMOTE", "LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE", "CONTRACT_RENEWAL", "TERMINATE"]);
export const LIFECYCLE_STATE = toned<S["EmployeeLifecycleEvent"]["state"]>("lifecycleState", { SCHEDULED: "info", APPLIED: "ok", APPLY_FAILED: "danger", CANCELLED: "neutral" });
export const LEAVE_TYPE = { ...values<NonNullable<S["CreateEmployeeLifecycleEventRequest"]["leave_type"]>>("leaveType", ["CHILDCARE", "MATERNITY", "WORK_INJURY", "ILLNESS", "PERSONAL", "OTHER"]), extensible: true };
export const STEP_UP_ACTION = { ...values<S["MobileStepUpActionKind"]>("stepUpAction", ["APPROVAL_DECISION", "POLL_VOTE", "EXIT_CONFIRM", "EXIT_RESCIND", "ELEVATED_GRANT", "PERIOD_UNLOCK", "IDENTITY_MERGE", "EXCEPTION_DECIDE", "SETTINGS_CHANGE", "CREDENTIAL_RESET", "TENANT_OFFBOARD", "OPERATOR_RECOVERY"]), extensible: true };
export const PERIOD_LOCK_DOMAIN = values<S["PeriodLock"]["domain"]>("periodLockDomain", ["payroll", "accounting"]);
export const IMPORT_ROW_STATUS = toned("importRowStatus", { CANDIDATE: "ok", PRESERVED: "warn", ERROR: "danger" });
// Employment facts, contracts and onboarding (EMP-MODEL).
export const WORKER_CLASS = values("workerClass", ["EMPLOYEE", "EXECUTIVE", "DISPATCHED_IN", "OUTSOURCED_ON_SITE", "PLATFORM_OR_FREELANCE"]);
export const PAY_UNIT = values("payUnit", ["MONTHLY", "HOURLY", "DAILY", "ANNUAL"]);
export const CONTRACT_KIND = values("contractKind", ["OPEN_ENDED", "FIXED_TERM", "PART_TIME", "DAILY", "DISPATCH_OUTSOURCING", "EXECUTIVE_MANDATE", "FREELANCE_SERVICE"]);
export const ID_TYPE = values("idType", ["RRN", "ARC", "DOMESTIC_RESIDENCE", "NOT_ISSUED"]);
export const PROBATION_STATE = toned("probationState", { NONE: "neutral", RUNNING: "info", DUE_SOON: "warn", OVERDUE: "danger", CONFIRMED: "ok" });

const known = (e: Enum, v: string) => {
  const id = `enum.${e.type}.${v}`;
  return isMessageId(id) ? t(id) : null;
};
// Legal entities, registrations and workplaces (pending contract).
export const BIZ_KIND = values<P.BizKind>("bizKind", ["CORPORATION", "INDIVIDUAL", "ID_NUMBER_ORG"]);
export const TAX_TYPE = values<P.NtsTaxType>("taxType", ["01", "02", "03", "04", "05", "06", "07"]);
export const RECORD_STATUS = toned<P.OperatingStatus>("recordStatus", { CONTINUING: "ok", SUSPENDED: "warn", CLOSED: "neutral" });
export const ISSUE_REASON = values<P.IssueReasonKind>("issueReason", ["NEW", "REISSUE", "CORRECTION", "OTHER_AS_PRINTED"]);
export const CORRECTION = values<P.CorrectionReason>("correction", ["TRADE_NAME", "RELOCATION", "INDUSTRY", "UNIT_TAXATION", "REPRESENTATIVE", "OTHER"]);
export const REPRESENTATION = values<P.RepresentationMode>("representation", ["SINGLE", "SEVERAL", "JOINT"]);
export const DIRECTOR_ROLE = values<P.DirectorRole>("directorRole", ["REPRESENTATIVE_DIRECTOR", "INSIDE_DIRECTOR", "OUTSIDE_DIRECTOR", "OTHER_NON_EXECUTIVE", "AUDITOR"]);
export const INSURER = values<P.Insurer>("insurer", ["NPS", "NHIS", "EI", "IACI"]);
export const INSURANCE_STATUS = toned<P.InsuranceStatus>("insuranceStatus", { NOT_ESTABLISHED: "neutral", ESTABLISHED_NUMBER_PENDING: "warn", ESTABLISHED: "ok", ENDED: "neutral" });
export const VERIFICATION = toned<P.VerificationTier>("verification", { NONE: "neutral", T1: "info", T2: "ok" });
export const CHANGE_MODE = toned<P.ChangeMode>("changeMode", { SETUP: "info", GOVERNED: "neutral", SOLE_HOLDER: "warn", MIGRATION: "neutral" });
export const UNVERIFIED_REASON = values<S["UnverifiedReason"]>("unverifiedReason", ["NOT_CHECKED", "NEW_REGISTRATION_PENDING", "SERVICE_UNAVAILABLE"]);

export const label = (e: Enum, v: string) => known(e, v) ?? (e.extensible ? t("enum.unknown") : v);
export const labeled = (e: Enum, v: string): Labeled => {
  const text = known(e, v);
  if (text === null && e.extensible) return { label: t("enum.unknown"), tone: "neutral", code: v };
  return text === null ? { label: v, tone: "neutral" } : { label: text, tone: (e.tone as Record<string, Tone> | undefined)?.[v] };
};

/** A server-resolved actor name; unknown renders as a dash; an unset name uses the shared person label. */
export const actor = (name?: string | null) => name == null ? "—" : personName(name);

/** A server code in words when the catalog has `id` (written as a template so the copy gate sees it), else the code itself. */
export const codeText = (id: string, code: string, vars?: Record<string, string | number>) => (isMessageId(id) ? t(id, vars as never) : code);
