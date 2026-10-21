// company structure reads and setup commands (backend: /org-structure, MR-12 batches on integ/mr-b8v2). During setup every
// department change applies at once in one batch and is undoable by its batch_id; after go-live the server refuses
// with phase_not_setup → submit_org_change and the governed path takes over.
import { api, ApiError, session, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get, type PathPrefix } from "../../lib/query";

export { entitiesRef, orgStructureRef as structureQuery, checklistRef } from "../../reference/entity/api";

type S = components["schemas"];
export type SetupOp = S["OrgSetupOp"];
export type Receipt = S["OrgSetupReceipt"];
export type ReorderRequest = S["ReorderStructureRequest"];
export { reorder } from "../../reference/org/api";
const once = (key: string) => ({ "Idempotency-Key": key });

/** Everything a structure change may alter: the tree, the entity reads it is enriched from, the checklist. */
export const STRUCTURE_READS: PathPrefix[] = ["/api/v1/org-structure", "/api/v1/org-units", "/api/v1/legal-entities", "/api/v1/onboarding"];

/** Create, rename, move and dissolve department in one transaction (all or nothing; a stale pin names its op). */
export const applyBatch = (key: string, ops: SetupOp[]) =>
  unwrap(api.POST("/api/v1/org-structure/batches", { params: { header: once(key) }, body: { ops } }));
/** Puts back every unit a batch touched (undo). */
export const undoBatch = (key: string, batchId: string) =>
  unwrap(api.POST("/api/v1/org-structure/batches/{batchId}/undo", { params: { header: once(key), path: { batchId } } }));

/** Someone else changed a unit since this chart read it (409 `stale_revision` on its pin). */
export const isStale = (error: unknown) => error instanceof ApiError && error.code === "stale_revision";

/** The signed-in person's name, for the export's stamp (printed by). */
export const whoAmI = () => session.claims?.name ?? "";
/** User-scoped chart preferences on this device. */
export const myId = () => session.claims?.sub;

/** People whose name or employee number matches, for the jump palette (a few, newest page). */
export const peopleSearchQuery = (q: string) => get("/api/v1/employees", { params: { query: { search: q, limit: 5 } } });
