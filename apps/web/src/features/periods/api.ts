import { ApiError, api, assertBoundPasskey, unwrap, type components } from "@console/api";
import { get } from "../../lib/query";
import type { PeriodLock } from "../../reference/periods/api";
import type { Window } from "./domain/period";

export type { PeriodLock, UnlockRequest } from "../../reference/periods/api";
export type Domain = PeriodLock["domain"];

/** Every lock, newest first; `active` (BW-15) says whether it is in force now (never unlocked, or its unlock window passed). */
export const locksQuery = get("/api/v1/period-locks", { params: { query: { limit: 200 } } });
/** What a lock, unlock or re-lock makes stale: the locks, and whether a closed attendance month takes writes. */
export const LOCK_READS = ["/api/v1/period-locks", "/api/v1/attendance"] as const;

/**
 * Org changes a lock can strand: effectuate (APPROVED) and archive (SETTLING) are refused while their
 * effective date sits in an active payroll or accounting lock.
 */
export const strandableChangesQuery = get("/api/v1/org-changes", { params: { query: { status: ["APPROVED", "SETTLING"], limit: 200 } } });

/** Locks a period with a reason code (BW-07) and its note; one user intent per key (an exact replay returns the lock). */
export const lockPeriod = (body: { domain: Domain; reasonCode?: string; reason?: string } & Window, key: string) =>
  unwrap(api.POST("/api/v1/period-locks", { params: { header: { "Idempotency-Key": key } }, body: { ...body, reason: body.reason || undefined } }));

export type UnlockOutcome = components["schemas"]["PeriodUnlockOutcome"];
/**
 * Unlocks a lock until `relockAt` (BW-15): the passkey step-up is bound to this lock and the exact reason and time
 * sent, so it authorizes this unlock and nothing else. With another close authority it waits for them
 * (PENDING_SECOND_PERSON); a sole holder unlocks at once, flagged for review.
 */
export const unlockPeriod = async (lockId: string, body: { reasonCode: string; note?: string; relockAt: string }, key: string) => {
  const stepUp = await assertBoundPasskey("PERIOD_UNLOCK", lockId, `PERIOD_UNLOCK\n${lockId}\n${body.reasonCode}\n${body.relockAt}`);
  return unwrap(api.POST("/api/v1/period-locks/{lockId}/unlock", { params: { path: { lockId }, header: { "Idempotency-Key": key } }, body: { ...body, note: body.note || undefined, stepUp } }));
};

/**
 * The second person approves the request they reviewed (BW-15): their own passkey step-up is bound to that request
 * id, so it approves this request and nothing else; a newer request replacing it is refused (409).
 */
export const approveUnlock = async (lockId: string, requestId: string, key: string) => {
  const stepUp = await assertBoundPasskey("PERIOD_UNLOCK", requestId, `PERIOD_UNLOCK_APPROVE\n${requestId}`);
  return unwrap(api.POST("/api/v1/period-locks/{lockId}/unlock/approve", { params: { path: { lockId }, header: { "Idempotency-Key": key } }, body: { requestId, stepUp } }));
};

/** The second person refuses the request with a note; the lock stays in force and the requester reads why. */
export const rejectUnlock = (lockId: string, requestId: string, note: string, key: string) =>
  unwrap(api.POST("/api/v1/period-locks/{lockId}/unlock/reject", { params: { path: { lockId }, header: { "Idempotency-Key": key } }, body: { requestId, note } }));

/** The settings the unlock form bounds its time box by (`period_lock.unlock_max_days`). */
export const settingsQuery = { ...get("/api/v1/settings"), staleTime: 5 * 60_000 };

/** True for a failed request the server answered with `status` (views may not import ApiError). */
export const failedWith = (e: unknown, status: number) => e instanceof ApiError && e.status === status;
