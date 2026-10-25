// Employee records, lifecycle events and exit cases: query descriptors.
import { api, ApiError, assertBoundPasskey, assertPasskey, session, unwrap } from "@console/api";
import { get } from "../../lib/query";
import type { components, paths } from "@console/api/schema";
import { unknownOutcome } from "./domain/accounts";
import { canonical } from "./domain/canonical";
import { employeeRecord, pinned, versionToSend } from "../../lib/record-versions";
import type { PatchOp } from "./domain/facts";

export type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
type Case = components["schemas"]["EmployeeExitCase"];
type Status = Case["status"];

/** Imported company text is evidence to map, never a legal-entity name. */
export const unmappedCompaniesQuery = get("/api/v1/employment-assignments/unmapped-companies");
export const mapCompany = (key: string, body: { company_text: string; legal_entity_id: string; workplace_id: string }) =>
  unwrap(api.POST("/api/v1/employment-assignments/map-company", { params: { header: { "Idempotency-Key": key } }, body }));

export const employeeQuery = (id: string) => get("/api/v1/employees/{id}", { params: { path: { id } } });
export const eventsQuery = (id: string) => get("/api/v1/employees/{id}/lifecycle-events", { params: { path: { id } } });

/** Cases still under way (a later step is open to someone). */
export const OPEN_EXIT_STATUSES: Status[] = ["REPORTED", "HR_CONFIRMED", "HQ_CONFIRMED", "SETTLEMENT_READY", "APPROVAL_DRAFTED"];
/** Cases at the end of the road: submitted for approval, rejected or cancelled. */
export const CLOSED_EXIT_STATUSES: Status[] = ["SUBMITTED", "REJECTED", "CANCELLED"];
/** The list filter: everything, the open or the closed cases, or one status (the server filters and counts). */
export type ExitFilter = "open" | "closed" | Status;
const groups = { open: OPEN_EXIT_STATUSES, closed: CLOSED_EXIT_STATUSES } as const;
export const statusParam = (f?: ExitFilter | Status[]) =>
  (Array.isArray(f) ? f.join(",") : f === "open" || f === "closed" ? groups[f].join(",") : f) || undefined;

/** Cases newest activity first (the server's largest page), narrowed to an employee or to statuses. */
export const exitCasesQuery = (q: { employeeId?: string; status?: Status[] }) =>
  get("/api/v1/hr/exit-cases", { params: { query: { employee_id: q.employeeId, status: statusParam(q.status), limit: 200 } } });
/** How many cases match a filter and a name or employee-number search (one row read; the server counts). */
export const exitCountQuery = (status?: ExitFilter, search?: string) =>
  get("/api/v1/hr/exit-cases", { params: { query: { status: statusParam(status), search: search || undefined, limit: 1 } } });
type CasePage = components["schemas"]["EmployeeExitCasePage"];
/**
 * The list's pages for useInfiniteQuery: keyed by the filter and page size (the offset is the page param,
 * not part of the key), each page read at its offset.
 * offset paging can skip or repeat a row when cases change mid-scroll; switch to a keyset cursor if the server serves one.
 */
export const exitCasesPagesQuery = (status: ExitFilter | undefined, limit: number, search?: string) => ({
  ...get("/api/v1/hr/exit-cases", { params: { query: { status: statusParam(status), search: search || undefined, limit } } }),
  queryFn: ({ pageParam }: { pageParam: number }) =>
    unwrap(api.GET("/api/v1/hr/exit-cases", { params: { query: { status: statusParam(status), search: search || undefined, limit, offset: pageParam } } })),
  initialPageParam: 0,
  getNextPageParam: (p: CasePage) => (p.offset + p.items.length < p.total ? p.offset + p.items.length : undefined),
});

export const caseQuery = (id: string) => get("/api/v1/hr/exit-cases/{id}", { params: { path: { id } } });

/** Reports an employee's exit, opening an exit case (one per user intent: `key`). */
export const reportExit = (body: { employee_id: string; effective_exit_date: string; site_manager_note: string; exit_reason_code?: string }, key: string) =>
  unwrap(api.POST("/api/v1/hr/exit-cases", { params: { header: { "Idempotency-Key": key } }, body }));

/** Records an exit case step: HR confirmation (the exit itself, with its statements) or HQ confirmation by another person. */
export const confirmExit = (id: string, body: components["schemas"]["ConfirmEmployeeExitCaseRequest"]) =>
  unwrap(api.POST("/api/v1/hr/exit-cases/{id}/confirm", { params: { path: { id } }, body }));
/** Saves the settlement draft (the server computes the figures) or, with `submit`, files exactly the stored package. */
export const draftExitApproval = (id: string, body: components["schemas"]["DraftEmployeeExitApprovalRequest"]) =>
  unwrap(api.POST("/api/v1/hr/exit-cases/{id}/approval-draft", { params: { path: { id } }, body }));
/** Rejects (any open state) or cancels (before HQ confirmation) a case with the reason the record keeps. */
export const closeExit = (id: string, reject: boolean, reason: string) =>
  unwrap(api.POST(reject ? "/api/v1/hr/exit-cases/{id}/reject" : "/api/v1/hr/exit-cases/{id}/cancel", { params: { path: { id } }, body: { reason } }));

/** The signed-in user's id (to tell my recorded step from someone else's). */
export const mySub = () => session.claims?.sub;
/** A refusal the screens act on: its status, code and, for lifecycle_schedule_conflict, the scheduled records named. */
export const problemOf = (e: unknown) =>
  e instanceof ApiError ? { status: e.status, code: e.code, message: e.message, refusals: e.refusals as unknown as ScheduleRefusal[] } : null;
/** No answer, or a server fault: the command may have been recorded, so it is looked up before anything is resent. */
export const unanswered = (e: unknown) => !(e instanceof ApiError) || (e.status === 0 || e.status >= 500);

/** Assigns the home branch; refused if someone changed the employee since `expectedUpdatedAt` (optimistic concurrency). */
export const assignHomeBranch = (id: string, branchId: string, expectedUpdatedAt: string) =>
  pinned(employeeRecord(id), expectedUpdatedAt, ["home_branch"], (at) =>
    unwrap(api.PUT("/api/v1/employees/{id}/home-branch", { params: { path: { id } }, body: { branch_id: branchId, expected_updated_at: at } })), (out) => out.updated_at);

/** The impact of replacing an account's system role (and, for a branch role on an account with none, its branches). */
export const previewAccountRole = (id: string, role: string, branchIds?: string[]) =>
  unwrap(api.POST("/api/v1/policy/users/{id}/assignment-preview", { params: { path: { id } }, body: { system_roles: [role], branch_ids: branchIds } }));

/** Replaces an account's role with what its assignment preview showed and the admin acknowledged. */
export const changeAccountRole = (id: string, role: string, previewReceiptId: string, branchIds?: string[]) =>
  unwrap(api.PATCH("/api/v1/users/{id}", { params: { path: { id } }, body: { roles: [role], branch_ids: branchIds, preview_acknowledged: true, preview_receipt_id: previewReceiptId } }));

/** Creates an account, linked to its employee record when one is given, under one idempotency key per intent. */
export const createAccount = (body: { display_name: string; employee_id?: string; roles: string[]; branch_ids: string[]; sign_in_id?: string }, key: string) =>
  unwrap(api.POST("/api/v1/users", { params: { header: { "Idempotency-Key": key } }, body }));

/** Every sign-in ID the account held, newest first (decisions #33). */
export const signInIdsQuery = (id: string) => get("/api/v1/users/{id}/sign-in-ids", { params: { path: { id } } });
/** A governed sign-in ID change: the old one stays an alias and is never reissued. */
export const changeSignInId = (id: string, body: components["schemas"]["ChangeSignInIdRequest"]) =>
  unwrap(api.POST("/api/v1/users/{id}/sign-in-id", { params: { path: { id } }, body }));

/** A single-use sign-in code, minted once the admin confirms it is them with their own passkey (step-up). */
export const issueSignInCode = async (userId: string, branchId?: string) =>
  unwrap(api.POST("/api/v1/auth/admin/otp/issue", { body: { user_id: userId, branch_id: branchId, step_up: await assertPasskey() } }));

/** Revokes every passkey and session of an account and mints a sign-in code, after the admin's step-up. */
export const resetPasskeys = async (userId: string) =>
  unwrap(api.POST("/api/v1/auth/admin/credential-reset", { body: { user_id: userId, step_up: await assertPasskey() } }));

/**
 * Sends an account command the server takes without an idempotency key. When its outcome is unknown (no answer, a
 * 5xx, a 409), the account is read again: if it already holds what was asked, the first press recorded it and that
 * account is the answer. Otherwise the original error stands, so pressing again is a fresh attempt, never a blind
 * re-send of one that may have landed.
 */
export const checkedOnAccount = async <O>(id: string, send: () => Promise<O>, holds: (u: components["schemas"]["UserSummary"]) => boolean) => {
  try {
    return await send();
  } catch (e) {
    if (!unknownOutcome(e)) throw e;
    const u = await get("/api/v1/users/{id}", { params: { path: { id } } }).queryFn().catch(() => undefined);
    if (u && holds(u)) return u;
    throw e;
  }
};

/** Deactivation deletes the account's passkeys, so it needs the admin's step-up; activation does not. */
export const setAccountActive = async (id: string, active: boolean) =>
  active
    ? unwrap(api.POST("/api/v1/users/{id}/activate", { params: { path: { id } } }))
    : unwrap(api.POST("/api/v1/users/{id}/deactivate", { params: { path: { id } }, body: { step_up: await assertPasskey() } }));

export const cancelScheduledEvent = ({ x, reason }: { x: LifecycleEvent; reason: string }) =>
  unwrap(api.POST("/api/v1/employees/{id}/lifecycle-events/{event_id}/cancel", { params: { path: { id: x.employee_id, event_id: x.id } }, body: { reason } }));

/** Requests or independently approves an employee link change with the actor's fresh passkey assertion. */
export const linkAccount = async (userId: string, employeeId: string | null, requestId?: string) =>
  unwrap(api.PATCH("/api/v1/users/{id}", { params: { path: { id: userId } }, body: { employee_id: employeeId, step_up: await assertPasskey(), account_link_request_id: requestId } }));

/** Someone changed the record since it was read (a 409 on an optimistic-concurrency write). */
export const isStale = (e: unknown) => e instanceof ApiError && e.status === 409;

export type LifecycleRequest = components["schemas"]["CreateEmployeeLifecycleEventRequest"];
/** Records one lifecycle event (applied now, or scheduled for a later date); one user intent per `key`. */
export const recordLifecycleEvent = (id: string, body: LifecycleRequest, key: string) =>
  unwrap(api.POST("/api/v1/employees/{id}/lifecycle-events", { params: { path: { id }, header: { "Idempotency-Key": key } }, body }));

/** BW-11: undoes the employee's latest applied change; `confirm` false previews the reservations it re-checks and writes nothing. */
export const rescindEvent = (x: Pick<LifecycleEvent, "id" | "employee_id">, body: { reason_code: string; note?: string; confirm: boolean }) =>
  unwrap(api.POST("/api/v1/employees/{id}/lifecycle-events/{event_id}/rescind", { params: { path: { id: x.employee_id, event_id: x.id } }, body: rescindBody(body) }));
const rescindBody = (b: { reason_code: string; note?: string; confirm: boolean }) => ({ reason_code: b.reason_code, note: b.note || null, confirm_cascades: b.confirm });
/** A reservation a rescission re-checks against the restored record (the preview's `cascades`). */
export type Cascade = { lifecycle_event_id: string; event_type: LifecycleEvent["event_type"]; effective_date: string };
/** BW-11: replaces the latest applied change with a corrected one of the same kind and date, in one step. */
export const correctEvent = (x: Pick<LifecycleEvent, "id" | "employee_id">, replacement: LifecycleRequest, r: { reason_code: string; note?: string }, key: string) =>
  unwrap(api.POST("/api/v1/employees/{id}/lifecycle-events/{event_id}/correct", { params: { path: { id: x.employee_id, event_id: x.id } }, headers: { "Idempotency-Key": key }, body: { replacement, reason_code: r.reason_code, note: r.note || null } }));
/** BW-11: rescinds every event of one bulk appointment, all or nothing; `confirm` false previews. */
export const rescindBatch = (batchId: string, body: { reason_code: string; note?: string; confirm: boolean }) =>
  unwrap(api.POST("/api/v1/employees/lifecycle-events/bulk/{batch_id}/rescind", { params: { path: { batch_id: batchId } }, body: rescindBody(body) }));

export type JobTitleKind = components["schemas"]["JobTitleKind"];
/** BW-13: the tenant's position catalog, most senior first, inactive titles included (history keeps resolving them). */
export const jobTitlesQuery = { ...get("/api/v1/job-titles"), staleTime: 60_000 };
/** Adds a title to the catalog (a label the company already has answers with that title). */
export const addJobTitle = (body: { kind: JobTitleKind; label: string; grade_rank: number | null }) => unwrap(api.POST("/api/v1/job-titles", { body }));
/** Renames, re-ranks or (de)activates a title; a title is never deleted. */
export const updateJobTitle = (id: string, body: { label?: string; grade_rank?: number; active?: boolean }) => unwrap(api.PATCH("/api/v1/job-titles/{id}", { params: { path: { id } }, body }));
/** BW-12: cumulative fixed-term service and the last day inside the statutory limit (Fixed-term Act Art. 4(1)). */
export const fixedTermQuery = (id: string) => get("/api/v1/employees/{id}/fixed-term", { params: { path: { id } } });

/** Current employees of one unit (direct members), for the positions it already uses. */
export const unitMembersQuery = (unitId: string) => get("/api/v1/employees", { params: { query: { org_unit_id: unitId, limit: 200 } } });

/** Home's renewal queue, read with Home's parameters so both share one cache entry. */
export const renewalQueueQuery = (before: string) => get("/api/v1/employees", { params: { query: { contract_ending_before: before, status: ["ACTIVE", "ON_LEAVE"], limit: 8 } } });

/** A scheduled event a refused change would make fail on its date (409 lifecycle_schedule_conflict). */
export type ScheduleRefusal = { lifecycle_event_id: string; event_type: string; effective_date: string; code: string; message: string };
/**
 * A server refusal's code, words and named records; null for anything that is not a server answer.
 * `ApiError.refusals` is typed for the bulk shape; a schedule conflict carries events instead.
 */
export const refusalOf = (e: unknown) =>
  e instanceof ApiError && e.fromServer ? { status: e.status, code: e.code, message: e.message, events: e.refusals as unknown as ScheduleRefusal[] } : null;

export type BulkRequest = components["schemas"]["BulkEmployeeLifecycleEventRequest"];
/** One all-or-nothing batch of transfers or promotions (one user intent per `key`: an exact replay returns the record). Sent without `Prefer: respond-async`, so the answer is the batch (200), never a job (202). */
export const bulkAppoint = (body: BulkRequest, key: string) =>
  unwrap(api.POST("/api/v1/employees/lifecycle-events/bulk", { params: { header: { "Idempotency-Key": key } }, body })) as Promise<components["schemas"]["BulkEmployeeLifecycleEventResponse"]>;

/** A page of the whole roster, every status (bulk paste looks employee numbers up in it; the server's largest page). */
export const ROSTER_PAGE = 1000;
export const rosterPageQuery = (offset: number) => get("/api/v1/employees", { params: { query: { limit: ROSTER_PAGE, offset } } });
/** The unplaced queue (BE-MIG W03, spec E8): its whole count and the first page of people with why and the file's department text. */
export const unplacedQuery = get("/api/v1/employees/import/unplaced", { params: { query: { limit: 500 } } });
/** The most employee numbers one list read takes (`employee_number[]`, 422 above). */
export const NUMBERS_PER_READ = 500;
/** Every person, any status, whose employee number is exactly one of `numbers` (up to NUMBERS_PER_READ). */
export const byNumbersQuery = (numbers: string[]) => get("/api/v1/employees", { params: { query: { employee_number: numbers, limit: ROSTER_PAGE } } });

/**
 * How a failed command ended: the server refused named employees, or answered otherwise (4xx: nothing was
 * recorded), or the outcome is unknown (no response, or a 5xx) and must be checked before anything is changed.
 */
export type Failure = { kind: "refused"; code: string; refusals: { employee_id: string; code: string; message: string }[] } | { kind: "answered" } | { kind: "lost" };
export const failureOf = (e: unknown): Failure =>
  !(e instanceof ApiError) || (e.status === 0 || e.status >= 500) ? { kind: "lost" } : e.refusals.length ? { kind: "refused", code: e.code, refusals: e.refusals } : { kind: "answered" };

// --- BW-17 change requests to HR, BW-18 corrections of employee master data and identity resolution ---

export type ChangeRequest = components["schemas"]["ChangeRequest"];
export type RequestStatus = ChangeRequest["status"];
export type Correction = components["schemas"]["EmployeeCorrection"];
export type CorrectionChanges = components["schemas"]["CorrectEmployeeRequest"]["changes"];
export type Resolution = components["schemas"]["EmployeeIdentityResolution"];

/** HR's lanes (org-wide manage): named to me, open to any HR person, or every request; anyone else reads `mine`, the requests they filed. */
export type Lane = "me" | "role" | "all";
export const REQUEST_PAGE = 20;
export const requestsQuery = (q: { lane: Lane; mine?: boolean; status?: RequestStatus; offset: number }) =>
  get("/api/v1/change-requests", {
    params: { query: { assignee: q.lane === "all" ? undefined : q.lane, requester: q.mine ? "me" : undefined, status: q.status, limit: REQUEST_PAGE, offset: q.offset } },
  });
/** The organization's open requests for Home's queue (HR only; the server lists a requester's own otherwise). */
/** How many open requests wait in a lane (one row read; the server counts). */
export const openCountQuery = (lane: Lane) => get("/api/v1/change-requests", { params: { query: { assignee: lane === "all" ? undefined : lane, status: "OPEN", limit: 1 } } });

/** Files a request to HR about an employee (a branch reader's way to ask for a correction or anything else). */
export const fileRequest = (b: { kind: "PROFILE_CORRECTION" | "OTHER"; employeeId: string; changes?: CorrectionChanges; reason: string; note?: string }) =>
  unwrap(api.POST("/api/v1/change-requests", { body: { kind: b.kind, subject_type: "EMPLOYEE", subject_id: b.employeeId, payload: b.changes ? { changes: b.changes } : {}, reason_code: b.reason, note: b.note || undefined } }));

/** HR applies or declines a request (never the requester's own); the requester alone withdraws it. */
export const decideRequest = (id: string, body: { decision: "APPLY" | "DECLINE" | "WITHDRAW"; reason: string; note?: string }) =>
  unwrap(api.POST("/api/v1/change-requests/{id}/decide", { params: { path: { id } }, body: { decision: body.decision, reason_code: body.reason, note: body.note || undefined } }));

/**
 * Corrects master data over the version read (`updatedAt`): name and phone apply at once; hire date, employment
 * type and base pay go to a second person when one exists (202 with the request). A sole holder applies them flagged
 * for review, after a passkey step-up bound to this person and these exact changes (401 `step_up_required` first).
 */
export const correctEmployee = (id: string, updatedAt: string, changes: CorrectionChanges, reason: string, note?: string) =>
  pinned(employeeRecord(id), updatedAt, Object.keys(changes), async (at) => {
    const send = (step_up?: Awaited<ReturnType<typeof assertBoundPasskey>>) =>
      unwrap(api.PATCH("/api/v1/employees/{id}", { params: { path: { id } }, body: { expected_updated_at: at, changes, reason_code: reason, note: note || undefined, step_up } }));
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401 && e.code === "step_up_required")) throw e;
      return send(await assertBoundPasskey("EXCEPTION_DECIDE", id, canonical(changes)));
    }
  }, (out) => out.updated_at);

/**
 * Resolves an identity review: DIFFERENT clears it; SAME merges this record into `keep`, after the user's passkey bound
 * to this employee and the exact verdict (then a second person applies it when one exists).
 */
export const resolveIdentity = async (id: string, body: { verdict: "SAME" | "DIFFERENT"; keep?: string; reason: string }) => {
  const step_up = body.verdict === "SAME" ? await assertBoundPasskey("IDENTITY_MERGE", id, JSON.stringify({ keep_employee_id: body.keep, verdict: "SAME" })) : undefined;
  return unwrap(api.POST("/api/v1/employees/{id}/identity-resolution", { params: { path: { id } }, body: { verdict: body.verdict, keep_employee_id: body.keep, reason_code: body.reason, step_up } }));
};

/** Records whose name or number matches, to pick the one an identity-review record is the same person as. */
export const samePersonQuery = (search: string) => ({ ...get("/api/v1/employees", { params: { query: { search, limit: 20 } } }), enabled: search.trim().length > 0 });

// --- BW-38 change sets: the caller's server-side draft of a bulk transfer or promotion, committed as one batch ---

export type ChangeSet = components["schemas"]["ChangeSetDetail"];
export type Intent = ChangeSet["intent"];
type LineDraft = paths["/api/v1/change-sets/{id}/lines"]["post"]["requestBody"]["content"]["application/json"];
type Signoffs = components["schemas"]["EmployeeLifecycleSignoffs"];

/** The caller's open draft for an intent, opened when there is none (two tabs share one). */
export const openChangeSet = (intent: Intent) => unwrap(api.POST("/api/v1/change-sets", { body: { intent } }));
/** Drafts or redrafts one employee's line (one per employee per set). */
export const putLine = (id: string, line: LineDraft) => unwrap(api.POST("/api/v1/change-sets/{id}/lines", { params: { path: { id } }, body: line }));
export const removeLine = (id: string, lineId: string) => unwrap(api.DELETE("/api/v1/change-sets/{id}/lines/{line_id}", { params: { path: { id, line_id: lineId } } }));
/** Records every line as one batch, all or nothing; one user intent per key (an exact replay returns the record). */
export const commitChangeSet = (id: string, signoffs: Signoffs, key: string) =>
  unwrap(api.POST("/api/v1/change-sets/{id}/commit", { params: { path: { id }, header: { "Idempotency-Key": key } }, body: { signoffs } }));

/**
 * Makes the open draft hold exactly `lines`: lines for other people are removed, each line is redrafted keeping the
 * version it was first drafted against (so a change made since is still caught at commit), except the `repin` people,
 * whom the user re-checked: they are drafted against their record now.
 * one request per line, eight at a time; a bulk line write if 500-line drafts feel slow.
 */
export async function syncLines(set: ChangeSet, lines: readonly LineDraft[], repin: ReadonlySet<string> = new Set()) {
  const want = new Set(lines.map((l) => l.employee_id));
  const drafted = new Map(set.lines.map((l) => [l.employee_id, l.expected_head_version]));
  const work = [
    ...set.lines.filter((l) => !want.has(l.employee_id)).map((l) => () => removeLine(set.id, l.id)),
    ...lines.map((l) => () => putLine(set.id, { ...l, expected_head_version: repin.has(l.employee_id) ? null : (l.expected_head_version ?? drafted.get(l.employee_id) ?? null) })),
  ];
  for (let i = 0; i < work.length; i += 8) await Promise.all(work.slice(i, i + 8).map((w) => w()));
}
/** The download purposes the server takes (export_purpose, 422 export_purpose_required without one). */
export { EXPORT_PURPOSES, type ExportPurpose } from "../../reference/directory/domain/export";
import type { ExportPurpose } from "../../reference/directory/domain/export";
/** The roster's current filter as a CSV file (every matching row); the server logs the download and its purpose first. */
export const exportRoster = (query: object, purpose: ExportPurpose) =>
  unwrap(api.GET("/api/v1/employees/export.csv", { params: { query: { ...query, export_purpose: purpose } }, parseAs: "blob" })) as Promise<Blob>;

// Employment facts, contract history and the derived onboarding checklist (EMP-MODEL). Each takes org-wide
// employee_directory_manage on the server (personal data and wages).

type ContractBody = paths["/api/v1/employees/{id}/contracts"]["post"]["requestBody"]["content"]["application/json"];
const onEmployee = (id: string) => ({ path: { id } });

export const factsQuery = (id: string) => get("/api/v1/employees/{id}/employment-facts", { params: onEmployee(id) });
export const contractsQuery = (id: string) => get("/api/v1/employees/{id}/contracts", { params: onEmployee(id) });

/** Someone saved a tested field first: re-read and merge (the record says which fields moved). */
export const isFieldConflict = (e: unknown) => e instanceof ApiError && e.code === "field_conflict";

/** Edits facts with a JSON Patch whose every write is preceded by a `test` of the value it was read as (ME-6). */
export const patchFacts = (id: string, ops: PatchOp[]) =>
  unwrap(api.PATCH("/api/v1/employees/{id}/employment-facts", { params: onEmployee(id), body: ops as never, headers: { "Content-Type": "application/json-patch+json" } }));

/** Records the end of probation, asserting the probation end date it was read with (409 stale_facts when it moved). */
export const confirmProbation = (id: string, endDate: string) =>
  unwrap(api.POST("/api/v1/employees/{id}/probation/confirm", { params: onEmployee(id), body: { expected: [{ path: "/employment/probation_end_date", value: endDate }] } }));

/** Records a contract row, a renewal or (with supersedes_id) a correction; rows are never edited. One key per intent. */
export const recordContract = (id: string, body: ContractBody, key: string) =>
  unwrap(api.POST("/api/v1/employees/{id}/contracts", { params: { ...onEmployee(id), header: { "Idempotency-Key": key } }, body }));

/** One person already on file who may be the one being registered (BW-19 `duplicate_candidate`). */
export type DuplicateCandidate = { employee_id: string; status: string; employee_number?: string | null; basis: "name_phone" | "name_birth_date"; remedy?: "rehire" | null };
export type DuplicateOverride = components["schemas"]["DuplicateOverride"];
/** The candidates of a 409 `duplicate_candidate`, else none: any other error is the form's usual message. */
export const duplicateCandidates = (e: unknown): DuplicateCandidate[] =>
  e instanceof ApiError && e.code === "duplicate_candidate" ? (e.refusals as unknown as DuplicateCandidate[]) : [];
/** records-02: whose a refused employee number is: a holder named in the refusal (any status), else a former number (an alias). */
export const numberHolder = (e: unknown): "held" | "former" =>
  e instanceof ApiError && (e.refusals as unknown as { holder?: unknown }[]).some((r) => r.holder) ? "held" : "former";

// --- registration (spec E3) ---
export type CreateEmployee = components["schemas"]["CreateEmployeeRequest"];
/** Registers one person with their company and workplace (MR-22, one call). */
export const createEmployee = (body: CreateEmployee) => unwrap(api.POST("/api/v1/employees", { headers: { "Idempotency-Key": body.idempotency_key }, body }));
/** Removes a registration made by mistake during the setup phase (MR-26); the employee number is freed. */
/** A write that ends the record (delete, void) overlaps no field this tab wrote: it goes past all of them. */
const ENDS: readonly string[] = [];
export const setupDeleteEmployee = (id: string, body: components["schemas"]["SetupDeleteEmployeeRequest"]) =>
  pinned(employeeRecord(id), body.expected_updated_at, ENDS, (at) => unwrap(api.DELETE("/api/v1/employees/{id}", { params: { path: { id } }, body: { ...body, expected_updated_at: at } })));
/** The same person starts a new period after an exit (same employee number and history; REHIRE event). */
export const rehireEmployee = (id: string, body: components["schemas"]["RehireEmployeeRequest"]) =>
  unwrap(api.POST("/api/v1/employees/{id}/rehire", { params: { path: { id } }, body }));

// --- bulk correction grid (spec E6-grid, MR-27) ---
export type BulkCorrection = components["schemas"]["BulkEmployeeCorrectionRequest"];
/** Each row at the version read, past this tab's own writes to other fields (its answer names no versions to keep). */
const pastOwn = (body: BulkCorrection): BulkCorrection => ({
  ...body,
  rows: body.rows?.map((r) => (r.expected_updated_at ? { ...r, expected_updated_at: versionToSend(employeeRecord(r.employee_id), r.expected_updated_at, Object.keys(r.changes)) } : r)),
});
/** Checks every row against the record now and returns what would be written, with a digest to commit by. */
export const previewBulkCorrection = (body: BulkCorrection) => unwrap(api.POST("/api/v1/employees/corrections/bulk/preview", { body: pastOwn(body) }));
/** Writes the previewed rows, all bound to the preview's digest. */
export const commitBulkCorrection = (body: BulkCorrection, key: string) =>
  unwrap(api.POST("/api/v1/employees/corrections/bulk", { params: { header: { "Idempotency-Key": key } }, body: pastOwn(body) }));

// --- appointment notices (spec E5-notice, BE-EMP-UI §4) ---
export type Notice = components["schemas"]["AppointmentNotice"];
/** Issues a notice for a bulk batch (or named events) with the next notice number; one user intent per key. */
export const issueNotice = (body: components["schemas"]["IssueAppointmentNoticeRequest"], key: string) =>
  unwrap(api.POST("/api/v1/appointment-notices", { params: { header: { "Idempotency-Key": key } }, body }));
export const noticeQuery = (id: string) => get("/api/v1/appointment-notices/{id}", { params: { path: { id } } });
export const noticesQuery = get("/api/v1/appointment-notices", { params: { query: { limit: 50 } } });
/** BE-EMP-UI §3: what a bulk act would meet now (counts and per-person refusals); writes and audits nothing. */
export const previewBulk = (body: BulkRequest) => unwrap(api.POST("/api/v1/employees/lifecycle-events/bulk/preview", { body }));
// --- lane: CRUD ---
/**
 * How a person's record ends (CRUD): registration cancel for a registration that should never have existed (the setup delete, or the
 * void after go-live: a sole holder confirms with a passkey bound to this person and the attestation), or exit (an exit
 * case). The server says which applies and the code for the one it does not offer.
 */
export const endOptionsQuery = (id: string) => get("/api/v1/employees/{id}/end-options", { params: { path: { id } } });

/** The reasons a registration is cancelled (the same codes as the personnel card's void sheet). */
export const CANCEL_REASONS = ["DUPLICATE", "NEVER_JOINED", "NOT_OURS", "OTHER"] as const;

export async function cancelRegistration(id: string, o: { updated_at: string; cancel_route: "DELETE" | "VOID" }, reason: string, attest: boolean, registerKept: boolean) {
  if (o.cancel_route === "DELETE") return setupDeleteEmployee(id, { expected_updated_at: o.updated_at, reason_code: reason, register_kept: registerKept });
  return pinned(employeeRecord(id), o.updated_at, ENDS, async (at) => {
    const send = (step_up?: Awaited<ReturnType<typeof assertBoundPasskey>>) =>
      unwrap(api.POST("/api/v1/employees/{id}/void", { params: { path: { id } }, body: { expected_updated_at: at, reason_code: reason, attest_never_worked: attest, step_up } }));
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401 && e.code === "step_up_required")) throw e;
      return send(await assertBoundPasskey("EXCEPTION_DECIDE", id, JSON.stringify({ attest_never_worked: attest })));
    }
  });
}

/** One outcome of a bulk exit report: the case, or the server's refusal code for that person. */
export type BulkExitRow = { id: string; name: string; ok: boolean; code?: string };

/**
 * exit reported for several people with one date and note: one report each, with the same checks as one by one, and each
 * person's own answer (bulk equals one-by-one, design-language §6.3). A refusal stops nobody else.
 * sequential client calls under one intent key per person; a server job when a selection passes the job threshold.
 */
export async function reportExits(people: { id: string; name: string }[], date: string, note: string, keys: Map<string, string>) {
  const out: BulkExitRow[] = [];
  for (const p of people) {
    const key = keys.get(p.id) ?? crypto.randomUUID();
    keys.set(p.id, key);
    try {
      await reportExit({ employee_id: p.id, effective_exit_date: date, site_manager_note: note }, key);
      out.push({ id: p.id, name: p.name, ok: true });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      out.push({ id: p.id, name: p.name, ok: false, code: e.code });
    }
  }
  return out;
}

/** System binding evidence for the existing HR identity review. */
export const personBindingReviewsQuery = (subject_id: string) => get("/api/v1/person-binding-reviews", { params: { query: { subject_id } } });
