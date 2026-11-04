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
  const q = asOf ?? (globalThis.location ? new URLSearchParams(globalThis.location.search).get("as_of") ?? undefined : undefined);
  return q && isDate(q) && q > today ? q : today;
};

export type InlineUnitSpec =
  | { kind: "create"; parentUnitId: string; name: string; effectiveDate: string; onDone?: (unitIds: string[]) => void }
  | { kind: "rename"; orgUnitId: string; fromName: string; name: string; effectiveDate: string; onDone?: () => void };

export async function submitInlineUnitChange(key: string, spec: InlineUnitSpec) {
  const title = spec.kind === "create" ? t("orgChange.title.create", { name: spec.name }) : t("orgChange.title.rename", { from: spec.fromName, to: spec.name });
  const body: components["schemas"]["CreateOrgChangeRequest"] = spec.kind === "create"
    ? { kind: "NEW", target: { kind: "ORG_UNIT", ref: spec.parentUnitId, label: spec.name }, proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: spec.parentUnitId, name: spec.name }], effectiveDate: spec.effectiveDate, reason: title }
    : { kind: "REORG", target: { kind: "ORG_UNIT", ref: spec.orgUnitId, label: title }, proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: spec.orgUnitId, name: spec.name }], effectiveDate: spec.effectiveDate, reason: title };
  const draft = await unwrap(api.POST("/api/v1/org-changes", { params: { header: { "Idempotency-Key": key } }, body }));
  let sent: "sent" | "unsent" = "sent";
  try {
    await landed(() => unwrap(api.POST("/api/v1/org-changes/{id}/submit", { params: { path: { id: draft.id } } })), () => api.GET("/api/v1/org-changes/{id}", { params: { path: { id: draft.id } } }), (d) => d.status !== "DRAFT" && d.status !== "PRECHECKED");
  } catch (e) {
    if (e instanceof ApiError && e.code === "preflight_blocked") sent = "unsent";
    else throw e;
  }
  const detail = sent === "sent" ? await unwrap(api.GET("/api/v1/org-changes/{id}", { params: { path: { id: draft.id } } })) : draft;
  const message = detail.status === "IN_APPROVAL" ? t("orgChange.receipt.routedChart", { title, code: draft.code }) : detail.status === "APPROVED" ? t("orgChange.receipt.scheduled", { title, code: draft.code, date: fmtDate(spec.effectiveDate) }) : t("orgChange.receipt.applied", { title, code: draft.code });
  return { id: draft.id, code: draft.code, sent, message, createdUnitIds: detail.created_unit_ids ?? [] };
}
