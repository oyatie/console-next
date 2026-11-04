import { api, ApiError, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import type { ReorderRequest, SetupOp } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { get, type PathPrefix } from "../../lib/query";
import { landed } from "../../lib/react/landed";
import { isDate } from "../../ui/date/days";

export const regionsQuery = get("/api/v1/regions");
export const branchesQuery = get("/api/v1/branches");
export const unitsQuery = get("/api/v1/org-units");

/** The server decides whether a department is deleted or dissolved. */
export const unitEndQuery = (id: string) => get("/api/v1/org-structure/units/{orgUnitId}/end-options", { params: { path: { orgUnitId: id } } });
export const unitMembersQuery = (orgUnitId: string) => get("/api/v1/org-structure/units/{orgUnitId}/members", { params: { path: { orgUnitId } } });

/** Every org read: the structure and its change proposals (what an org command may change). */
export const ORG_READS: PathPrefix[] = ["/api/v1/regions", "/api/v1/branches", "/api/v1/org-units", "/api/v1/org-changes"];

/** Every read a structure command may change: the tree, units, entities and workplaces, setup, changes and people. */
export const STRUCTURE_READS: PathPrefix[] = ["/api/v1/org-structure", "/api/v1/org-units", "/api/v1/branches", "/api/v1/legal-entities", "/api/v1/workplaces", "/api/v1/onboarding", "/api/v1/org-changes", "/api/v1/employees"];
/** Applies setup department ops in one transaction (at once, during setup); the receipt's batch_id undoes them all. */
export const applySetup = (key: string, ops: SetupOp[]) => unwrap(api.POST("/api/v1/org-structure/batches", { params: { header: { "Idempotency-Key": key } }, body: { ops } }));
/** Sets the order of a parent's children (a legal entity's workplaces, a workplace's or department's departments): every current child once. */
export const reorder = (key: string, body: ReorderRequest) => unwrap(api.PUT("/api/v1/org-structure/order", { params: { header: { "Idempotency-Key": key } }, body }));

export const defaultEffectiveDate = (today: string, asOf?: string): string => {
  const q = asOf;
  return q && isDate(q) && q > today ? q : today;
};

export type InlineUnitValues = { effectiveDate: string; reason: string; submit: boolean };
export type InlineUnitSpec = InlineUnitValues & (
  | { kind: "create"; parentUnitId: string; name: string; onDone?: (unitIds: string[]) => void }
  | { kind: "rename"; orgUnitId: string; fromName: string; name: string; onDone?: () => void });

/** The proposal describes the edit; its reason is always entered by the user. */
export function inlineUnitBody(spec: InlineUnitSpec): components["schemas"]["CreateOrgChangeRequest"] {
  const title = spec.kind === "create" ? t("orgChange.title.create", { name: spec.name }) : t("orgChange.title.rename", { from: spec.fromName, to: spec.name });
  return spec.kind === "create"
    ? { kind: "NEW", target: { kind: "ORG_UNIT", ref: spec.parentUnitId, label: spec.name }, proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: spec.parentUnitId, name: spec.name }], effectiveDate: spec.effectiveDate, reason: spec.reason.trim() }
    : { kind: "REORG", target: { kind: "ORG_UNIT", ref: spec.orgUnitId, label: title }, proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: spec.orgUnitId, name: spec.name }], effectiveDate: spec.effectiveDate, reason: spec.reason.trim() };
}

export const changeReceipt = (status: string, title: string, code: string, date: string) =>
  t(status === "IN_APPROVAL" ? "orgChange.receipt.routedChart" : status === "APPROVED" ? "orgChange.receipt.scheduled" : "orgChange.receipt.applied", { title, code, date: fmtDate(date) });

type S = components["schemas"];
const once = (key: string) => ({ "Idempotency-Key": key });
const at = (id: string) => ({ path: { id } });

/** Drafts any org change in one write: its ops, date and reason together. */
export const draftChange = (key: string, body: S["CreateOrgChangeRequest"]) => unwrap(api.POST("/api/v1/org-changes", { params: { header: once(key) }, body }));
/** Sets a draft's date and reason (the region and branch drafting URLs take neither). */
export const dateDraft = (id: string, body: { effectiveDate: string; reason: string }) => unwrap(api.PATCH("/api/v1/org-changes/{id}", { params: at(id), body }));
const submitChange = (id: string) => unwrap(api.POST("/api/v1/org-changes/{id}/submit", { params: at(id) }));
export const readChange = (id: string) => api.GET("/api/v1/org-changes/{id}", { params: at(id) });
/**
 * Submits a draft: "unsent" when its preflight blocks it (the draft stays, its page shows why). Submit takes
 * no Idempotency-Key, so after a lost response or a 409 the change itself says whether it already went.
 */
export async function submitDraft(id: string): Promise<"sent" | "unsent"> {
  try {
    await landed(() => submitChange(id), () => readChange(id), (d) => d.status !== "DRAFT" && d.status !== "PRECHECKED");
    return "sent";
  } catch (e) {
    if (e instanceof ApiError && e.code === "preflight_blocked") return "unsent";
    throw e;
  }
}

/**
 * One proposal for a structure change after go-live: drafted with its ops, date and reason, then submitted unless
 * only saved. "unsent": its preflight blocks it; the draft stays and its record says why.
 */
export async function governed(key: string, body: S["CreateOrgChangeRequest"], submit: boolean) {
  const draft = await draftChange(key, body);
  const sent = submit ? await submitDraft(draft.id) : ("saved" as const);
  const result = sent === "sent" ? await unwrap(readChange(draft.id)) : draft;
  return { id: draft.id, code: draft.code, sent, select: result.created_unit_ids?.[0], status: result.status };
}
