// REQUESTED, NOT SERVED: the run record and its two-person rollback (BW-10 item 9). No backend branch serves
// `/api/v1/employee-import-runs` yet (backend-followups #21 (a)), so the screens that use these types are built but not
// mounted. Replace with the generated schema once the paths are published.

export type ImportPerson = { id: string; name: string };
export type ImportRollback = {
  requested_by: ImportPerson;
  requested_at: string;
  reason_code: string;
  memo?: string | null;
  decided_by?: ImportPerson | null;
  decided_at?: string | null;
  decision?: "APPROVE" | "REFUSE" | null;
};
export type ImportRunStatus = "PREVIEW" | "DRY_RUN" | "APPLIED" | "ROLLBACK_REQUESTED" | "ROLLED_BACK";
export type ImportRun = {
  id: string;
  source_filename: string;
  status: ImportRunStatus;
  created_at: string;
  applied_at?: string | null;
  applied_by?: ImportPerson | null;
  inserted: number;
  updated: number;
  skipped: number;
  rollback_until?: string | null;
  rollback?: ImportRollback | null;
  rollback_kept: ImportPerson[];
  allowed: ("request_rollback" | "decide_rollback")[];
};
