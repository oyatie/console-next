import { api, unwrap } from "@console/api";
import type { ReorderRequest, SetupOp } from "@console/api/pending";
import { get, type PathPrefix } from "../../lib/query";

export const regionsQuery = get("/api/v1/regions");
export const branchesQuery = get("/api/v1/branches");
export const unitsQuery = get("/api/v1/org-units");

/** The server decides whether a department is deleted or dissolved. */
export const unitEndQuery = (id: string) => get("/api/v1/org-structure/units/{orgUnitId}/end-options", { params: { path: { orgUnitId: id } } });

/** Every org read: the structure and its change proposals (what an org command may change). */
export const ORG_READS: PathPrefix[] = ["/api/v1/regions", "/api/v1/branches", "/api/v1/org-units", "/api/v1/org-changes"];

/** Every read a structure command may change: the tree, units, entities and workplaces, setup, changes and people. */
export const STRUCTURE_READS: PathPrefix[] = ["/api/v1/org-structure", "/api/v1/org-units", "/api/v1/branches", "/api/v1/legal-entities", "/api/v1/workplaces", "/api/v1/onboarding", "/api/v1/org-changes", "/api/v1/employees"];
/** Applies setup department ops in one transaction (at once, during setup); the receipt's batch_id undoes them all. */
export const applySetup = (key: string, ops: SetupOp[]) => unwrap(api.POST("/api/v1/org-structure/batches", { params: { header: { "Idempotency-Key": key } }, body: { ops } }));
/** Sets the order of a parent's children (a legal entity's workplaces, a workplace's or department's departments): every current child once. */
export const reorder = (key: string, body: ReorderRequest) => unwrap(api.PUT("/api/v1/org-structure/order", { params: { header: { "Idempotency-Key": key } }, body }));
