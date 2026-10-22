// Shared setup batch writes and their undo, used by organization and legal-entity registration.
import { api, unwrap } from "@console/api";
import type { EntitySetupBatchRequest, OrgSetupOp } from "@console/api/pending";
import type { PathPrefix } from "../../../lib/query";
import { stepKey } from "../../entity/api";

/** Every read a setup batch can change (the tree, the entity records, the setup rail and the history). */
export const BATCH_READS: PathPrefix[] = ["/api/v1/org-structure", "/api/v1/entity-setup", "/api/v1/legal-entities", "/api/v1/workplaces", "/api/v1/onboarding", "/api/v1/org-units"];

const once = (key: string) => ({ "Idempotency-Key": key });
export const entityBatch = (body: EntitySetupBatchRequest, key?: string) =>
  unwrap(api.POST("/api/v1/entity-setup/batches", { params: { header: key ? once(key) : undefined }, body }));
export const applyOrgBatch = (key: string, ops: OrgSetupOp[]) => unwrap(api.POST("/api/v1/org-structure/batches", { params: { header: once(key) }, body: { ops } }));
export const undoOrgBatch = (key: string, batchId: string) => unwrap(api.POST("/api/v1/org-structure/batches/{batchId}/undo", { params: { header: once(key), path: { batchId } } }));
export const undoEntityBatch = (key: string, batchId: string) => unwrap(api.POST("/api/v1/entity-setup/batches/{batchId}/undo", { params: { header: once(key), path: { batchId } } }));

/** What a commit recorded: the receipts to undo, newest first. */
export type Committed = { orgBatchId: string | null; entityBatchId: string | null; workplaceIds: Record<string, string> };

/** Undoes a commit: its department first (they sit in the new workplace), then its workplace. */
export async function undoCommitted(key: string, c: Committed) {
  if (c.orgBatchId) await undoOrgBatch(stepKey(key, 1), c.orgBatchId);
  if (c.entityBatchId) await undoEntityBatch(stepKey(key, 2), c.entityBatchId);
}

