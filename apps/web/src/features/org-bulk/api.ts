// Setup batches (MR-12 org-structure, MR-29 entity-setup) as one user intent: new workplace first, then their department,
// and one undo that undoes both (S7, D18). Served by integ/mr-b9; typed in packages/api/src/pending/entity.ts.
import { api, ApiError, session, unwrap } from "@console/api";
import type { EntitySetupOp, EntitySetupResult, InsurerInput, OrgSetupOp } from "@console/api/pending";
import { get } from "../../lib/query";
import { stepKey } from "../../reference/entity/api";
import { applyOrgBatch, entityBatch, type Committed } from "../../reference/org/api/setup-batch";
export { BATCH_READS, applyOrgBatch, entityBatch, undoOrgBatch, undoEntityBatch, undoCommitted, type Committed } from "../../reference/org/api/setup-batch";

export const structureQuery = get("/api/v1/org-structure");
export const orgBatchesQuery = get("/api/v1/org-structure/batches");
export const entityBatchesQuery = get("/api/v1/entity-setup/batches");
/** The newest governed org changes, any status (the history and its scheduled banner). */
export const changesQuery = get("/api/v1/org-changes", { params: { query: { limit: 200 } } });
/**
 * The people a sheet names as heads, by exact employee number in one read (org-06; ≤ 500, the endpoint's own cap). Those who left
 * are not heads, so only people still employed are asked for.
 */
export const headsQuery = (numbers: string[]) =>
  ({
    ...get("/api/v1/employees", { params: { query: { employee_number: numbers, status: ["ACTIVE", "ON_LEAVE", "PRE_HIRE"], limit: 500 } } }),
    enabled: numbers.length > 0,
  });
/** The signed-in user's id, as the records name their actor. */
export const me = () => session.claims?.sub;
/** The rows the server refused in a dry run (every refusal at once), as a thrown error the page lists. */
export class RowsRefused extends Error {
  constructor(readonly items: EntitySetupResult["items"]) {
    super("rows_refused");
  }
}

/**
 * Writes the workplace (dry run, then the digest-bound apply) and then the department the second batch places by the new ids.
 * `memo` survives a retry of the same intent: once the workplace are written they are not dry-run again (the dry run
 * would now refuse them as already existing); the apply's key replays the receipt instead.
 */
export async function commitBatches(key: string, entityOps: EntitySetupOp[], orgOps: (ids: Record<string, string>) => OrgSetupOp[], memo: { entity?: Committed }): Promise<Committed> {
  let done = memo.entity;
  if (!done) {
    done = { orgBatchId: null, entityBatchId: null, workplaceIds: {} };
    if (entityOps.length) {
      const dry = await entityBatch({ dry_run: true, ops: entityOps });
      const refused = dry.items.filter((i) => i.outcome === "ERROR");
      if (refused.length) throw new RowsRefused(refused);
      const applied = await entityBatch({ dry_run: false, preview_digest: dry.preview_digest, ops: entityOps }, stepKey(key, 1));
      done.entityBatchId = applied.batch_id ?? null;
      for (const i of applied.items) if (i.ref && i.target_id) done.workplaceIds[i.ref] = i.target_id;
    }
    memo.entity = done;
  }
  const ops = orgOps(done.workplaceIds);
  const org = ops.length ? await applyOrgBatch(stepKey(key, 2), ops) : null;
  return { ...done, orgBatchId: org?.batch_id ?? null };
}

/** A workplace's dated social insurance revision, pinned to the insurance version it was read at (409 stale_revision otherwise). */
export const reviseInsurance = (key: string, workplaceId: string, body: { expected_version: number; effective_from: string; reason_code: string; insurers: InsurerInput[] }) =>
  unwrap(api.PUT("/api/v1/workplaces/{workplaceId}/insurance", { params: { path: { workplaceId }, header: { "Idempotency-Key": key } }, body }));

/** The stable code of a server refusal, for the slice's own words; undefined for a network fault. */
export const refusalCode = (e: unknown) => (e instanceof ApiError ? e.code : undefined);
