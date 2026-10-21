// Employee import: preview → dry run → apply and stored run history (BW-10, MR-7).
import { api, ApiError, unwrap } from "@console/api";
import { get } from "../../lib/query";
import { REFUSED_BEFORE_WRITE } from "../../lib/react/command";
import type { ApplyJob, ImportDecisions, ImportPreview, ImportReport } from "./domain/contract";
import type { ImportRun } from "./domain/pending";
import { HEAD_BYTES, workbookKind } from "./domain/workbook";

const idem = (key: string) => ({ header: { "Idempotency-Key": key } });

/** The reason domain a left-out row picks from (BW-07) and its Other code, which needs a note. */
export const EXCLUDE_REASONS = "import_exclude";
export const OTHER = "OTHER";
export const NOTE_MAX = 1000;
/** The server refuses a larger upload (registry import.upload.max_mib, 16 by default); the drop zone answers first. */
export const MAX_BYTES = 16 * 1024 * 1024;
/** The employee number a person may be given (EmployeeImportDecisions.employee_numbers). */
export const NUMBER_MAX = 40;

/** The server's answer to a workbook it cannot open: `protected` (password or DRM) or `unreadable` (not an .xlsx). */
export const refusedKind = (e: unknown) =>
  e instanceof ApiError ? (e.code === "workbook_protected" ? "protected" : e.code === "workbook_not_xlsx" ? "unreadable" : null) : null;
/**
 * A 409 on apply: rows changed since the dry run (each refusal names one row), or the digest is no longer the run's
 * latest dry run. Nothing was written either way; the dry run is computed again.
 */
export const changedRows = (e: unknown) =>
  e instanceof ApiError && (e.code === "rows_changed_since_preview" || e.code === "dry_run_digest_mismatch") ? Math.max(1, e.refusals.length) : 0;
/**
 * 408: the apply outlasted the server's request timeout (30 s by default; thousands of rows can). A part may be in (a
 * replayed apply completes what an interrupted one left), so the remedy is a dry run again and smaller files.
 */
export const timedOut = (e: unknown) => e instanceof ApiError && e.status === 408;
/** 409 on a dry run or apply of a run older than import.staged_identity.ttl_days: its sealed rows are gone; upload again. */
export const runExpired = (e: unknown) => e instanceof ApiError && e.code === "import_run_expired";

/** What a chosen file is, read from its first bytes before any upload. */
export const sniff = async (file: Blob) => workbookKind(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()));

/**
 * Uploads a workbook. The pay period is a required part of the server's request and is never defaulted. `mapping`
 * (domain/mapping) carries the header rows and columns the operator set; the server remembers the labels.
 */
export const preview = (file: File, start: string, end: string, mapping?: string) =>
  unwrap(
    api.POST("/api/v1/employees/import/preview", {
      // Multipart: the typed body is replaced by the FormData the endpoint expects.
      body: { file: "", pay_period_start: start, pay_period_end: end },
      bodySerializer: () => {
        const form = new FormData();
        form.append("file", file);
        // Both or neither (BE-MIG W12: the roster's period is optional).
        if (start && end) {
          form.append("pay_period_start", start);
          form.append("pay_period_end", end);
        }
        if (mapping) form.append("mapping", mapping);
        return form;
      },
    }),
  ) as Promise<ImportPreview>;

/** Plans every row against the live roster with the decisions so far; each call replaces the run's digest. */
export const dryRun = (runId: string, decisions: ImportDecisions) =>
  unwrap(api.POST("/api/v1/employees/import/{run_id}/dry-run", { params: { path: { run_id: runId } }, body: { decisions } }));

/**
 * Applies exactly the dry run named by its digest, as a job (`Prefer: respond-async`, BE-MIG W11; r3:hire-02): every
 * refusal is still immediate, then the job comes back (202) and the screen follows it over the event stream; an applied
 * and settled run answers its report (200). A repeat with the same digest gets the same job.
 */
export const apply = async (runId: string, digest: string): Promise<{ job: ApplyJob } | { report: ImportReport }> => {
  const out = await unwrap(
    api.POST("/api/v1/employees/import/{run_id}/apply", { params: { path: { run_id: runId } }, body: { dry_run_digest: digest }, headers: { Prefer: "respond-async" } }),
  );
  return "state" in out ? { job: out } : { report: out as ImportReport };
};

/** The run's apply job, read once per `import_run` frame (the live stream invalidates it; never polled, #27). */
export const applyJobQuery = (runId: string) => get("/api/v1/employees/import/{run_id}/apply", { params: { path: { run_id: runId } } });
export const readJob = (runId: string) => unwrap(api.GET("/api/v1/employees/import/{run_id}/apply", { params: { path: { run_id: runId } } }));
/**
 * An apply whose answer never arrived (no response, a gateway timeout, a 5xx with no code of ours): the job may well be
 * running, so the run is read again before anything offers the apply twice. A typed refusal is not one.
 */
/** How long a shed request asks to wait (its Retry-After), when it said. */
export const retryAfterOf = (e: unknown) => (e instanceof ApiError && e.retryAfterMs ? e.retryAfterMs : undefined);
export const lostAnswer = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 408 || (e.status >= 500 && !REFUSED_BEFORE_WRITE.has(e.code));

export const excludeReasonsQuery = get("/api/v1/reason-codes", { params: { query: { domain: EXCLUDE_REASONS } } });

// Run history is served; rollback commands remain unmounted until their governed write path is available.
type Raw = Record<"GET" | "POST", (path: string, init?: { body?: unknown; params?: { header?: Record<string, string> } }) => Promise<{ data?: unknown; error?: unknown; response: Response }>>;
const raw = () => api as unknown as Raw;
export const RUNS = "/api/v1/employee-import-runs";
export const ROLLBACK_REASONS = "import_rollback";
export const MEMO_MAX = 500;
export const runsQuery = get(RUNS);
export const runQuery = (id: string) => get("/api/v1/employee-import-runs/{run_id}", { params: { path: { run_id: id } } });
export const rollbackReasonsQuery = get("/api/v1/reason-codes", { params: { query: { domain: ROLLBACK_REASONS } } });
export const requestRollback = (id: string, reason: { code: string; memo: string }, key: string) =>
  unwrap(raw().POST(`${RUNS}/${id}/rollback`, { params: idem(key), body: { reason_code: reason.code, memo: reason.memo || null } })) as Promise<ImportRun>;
export const decideRollback = (id: string, decision: "APPROVE" | "REFUSE", key: string) =>
  unwrap(raw().POST(`${RUNS}/${id}/rollback/decision`, { params: idem(key), body: { decision } })) as Promise<ImportRun>;

// --- the migration check: the applied run checked row by row and signed off (spec E7-reconcile/-row/-signoff, BE-EMP-UI §5) ---
const onRun = (runId: string) => ({ path: { run_id: runId } });
export const reconcileQuery = (runId: string) => get("/api/v1/employees/import/{run_id}/reconcile", { params: onRun(runId) });
/** The rows to check, in file order (one page of the server's largest). */
export const reconcileRowsQuery = (runId: string) => get("/api/v1/employees/import/{run_id}/reconcile/rows", { params: { ...onRun(runId), query: { limit: 500 } } });
/** Marks one row checked (or to look at again) over the version read: 409 stale_revision when someone marked it since. */
export const checkRow = (runId: string, sourceKey: string, body: { state: "CONFIRMED" | "NEEDS_CHECK"; note?: string | null; expected_version: number }) =>
  unwrap(api.PUT("/api/v1/employees/import/{run_id}/reconcile/rows/{source_key}", { params: { path: { run_id: runId, source_key: sourceKey } }, body }));
/** The HR sign-off, bound to the open count on screen; rows still open need the explicit acknowledgement (428 without). */
export const signOff = (runId: string, body: { expected_open_count: number; acknowledge_open: boolean; note?: string | null }) =>
  unwrap(api.POST("/api/v1/employees/import/{run_id}/signoff", { params: onRun(runId), body }));
/** A row someone marked since it was read (409 stale_revision): the rows are read again. */
export const staleRow = (e: unknown) => e instanceof ApiError && e.code === "stale_revision";
/** The refusal code of a failed import call (null for a lost one). */
export const importCode = (e: unknown) => (e instanceof ApiError ? e.code : null);
/** 422 import_row_limit: the most rows one apply takes and how many this file has (BE-MIG W11). */
export const rowLimitOf = (e: unknown) =>
  e instanceof ApiError && e.code === "import_row_limit" ? ((e.refusals as unknown as { max: number; rows: number }[])[0] ?? null) : null;
