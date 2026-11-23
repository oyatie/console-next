import { expect, test, vi } from "vitest";
import * as consoleApi from "@console/api";
import { api, ApiError } from "@console/api";
import { readIdentity } from "../../lib/query";
import { recordImportRowIdentifier, repairImportCells, rollbackPreviewQuery, lostAnswer, previewRollback, requestRollback, runQuery, runsQuery } from "./api";

test("a typed transport failure checks the existing import job", () => {
  expect(lostAnswer(new ApiError(0, "command_unknown", ""))).toBe(true);
  expect(lostAnswer(new TypeError("Failed to fetch"))).toBe(true);
  expect(lostAnswer(new ApiError(408, "request_timeout", ""))).toBe(true);
  expect(lostAnswer(new ApiError(503, "service_unavailable", ""))).toBe(true);
});

test("history reads use the published list and parameterized record path", async () => {
  const get = vi.spyOn(api, "GET").mockImplementation((async () => ({ data: { items: [], next_cursor: null }, response: new Response(null, { status: 200 }) })) as never);
  try {
    await runsQuery.queryFn();
    expect(get).toHaveBeenLastCalledWith("/api/v1/employee-import-runs", undefined);
    await runQuery("run-1").queryFn();
    expect(get).toHaveBeenLastCalledWith("/api/v1/employee-import-runs/{run_id}", { params: { path: { run_id: "run-1" } } });
    expect(readIdentity(runQuery("run-1"))).not.toEqual(readIdentity(runQuery("run-2")));
    expect(readIdentity(rollbackPreviewQuery("run-1"))).not.toEqual(readIdentity(rollbackPreviewQuery("run-2")));
  } finally { get.mockRestore(); }
});

test("answered refusals never masquerade as a lost import response", () => {
  for (const [status, code] of [[403, "forbidden"], [409, "dry_run_digest_mismatch"], [503, "import_apply_busy"], [503, "import_run_expired"]] as const) {
    expect(lostAnswer(new ApiError(status, code, ""))).toBe(false);
  }
});

test("rollback posts the published preview and digest-bound command paths with its idempotency key", async () => {
  const post = vi.spyOn(api, "POST").mockImplementation((async () => ({ data: { run_id: "run-1", status: "ROLLED_BACK" }, response: new Response(null, { status: 200 }) })) as never);
  try {
    await previewRollback("run-1");
    expect(post).toHaveBeenLastCalledWith("/api/v1/employee-import-runs/{run_id}/rollback/preview", expect.objectContaining({ params: { path: { run_id: "run-1" } } }));
    const body = { preview_digest: "a".repeat(64), acknowledged: true };
    await requestRollback("run-1", body, "rollback-intent-key");
    expect(post).toHaveBeenLastCalledWith("/api/v1/employee-import-runs/{run_id}/rollback", expect.objectContaining({ params: { path: { run_id: "run-1" }, header: { "Idempotency-Key": "rollback-intent-key", Prefer: "respond-async" } }, body }));
    expect(post).toHaveBeenCalledTimes(2);
  } finally { post.mockRestore(); }
});

test.each([
  [404, "import_run_not_found"], [409, "import_run_not_applied"], [409, "import_run_already_rolled_back"],
  [409, "import_run_predates_ledger"], [409, "import_rollback_pending"], [409, "import_rollback_window_closed"],
  [409, "import_rollback_blocked"], [409, "rows_changed_since_preview"], [422, "import_rollback_ack_required"],
  [422, "reason_code"], [401, "step_up_required"], [401, "step_up_failed"],
  [403, "import_rollback_sole_holder_refused"], [403, "authz_sod_requester"], [403, "scope_tenant_wide_only"],
] as const)("rollback preserves the server's %i %s refusal and blocker details", async (status, code) => {
  const blockers = [{ employee_id: "person-1", kind: "changed_since", field: "job", record: "/people/person-1", since: "2026-10-01T03:00:00Z" }];
  const post = vi.spyOn(api, "POST").mockImplementation((async () => ({ error: { error: { code, message: "refused", refusals: blockers } }, response: new Response(null, { status }) })) as never);
  try {
    await expect(requestRollback("run-1", { preview_digest: "a".repeat(64), acknowledged: true }, "rollback-intent-key"))
      .rejects.toMatchObject({ status, code, refusals: blockers });
  } finally { post.mockRestore(); }
});

test("a database timeout is a confirmed atomic refusal, not an uncertain transport result", () => {
  expect(lostAnswer(new ApiError(503, "import_apply_timed_out", ""))).toBe(false);
});

test("repairImportCells and recordImportRowIdentifier call #875 endpoints with bound PII_RECORD step-up", async () => {
  const put = vi.spyOn(api, "PUT").mockImplementation((async (url: string) => ({
    data: url.includes("/cells")
      ? { run_id: "run-9", repaired_rows: 1, cells: { "S1:5": { hire_date: "2026-11-01" } } }
      : { run_id: "run-9", source_key: "S1:2", id_type: "DOMESTIC_RESIDENCE", recorded: true, sex_derived: "FEMALE" },
    response: new Response(null, { status: 200 }),
  })) as never);
  const stepUp = vi.spyOn(consoleApi, "assertBoundPasskey").mockResolvedValue({
    ceremony_id: "cer-1",
    credential: { id: "cred-1" },
    binding: {
      action_kind: "PII_RECORD",
      object_id: "run-9",
      reason_key: "passkey_step_up_pii_record",
      replay_attempt: null,
      payload_hash: "0".repeat(64),
    },
  } as never);
  try {
    await repairImportCells("run-9", { "S1:5": { hire_date: "2026-11-01" } });
    expect(put).toHaveBeenCalledWith("/api/v1/employees/import/{run_id}/cells", {
      params: { path: { run_id: "run-9" } },
      body: { cells: { "S1:5": { hire_date: "2026-11-01" } } },
    });

    const out = await recordImportRowIdentifier("run-9", "S1:2", { rrn: "1".repeat(13), id_type: "DOMESTIC_RESIDENCE" });
    expect(stepUp).toHaveBeenCalledWith("PII_RECORD", "run-9", "run-9:S1:2");
    expect(put).toHaveBeenLastCalledWith("/api/v1/employees/import/{run_id}/rows/{source_key}/identifier", {
      params: { path: { run_id: "run-9", source_key: "S1:2" } },
      body: expect.objectContaining({ rrn: "1".repeat(13), id_type: "DOMESTIC_RESIDENCE" }),
    });
    expect(out).toMatchObject({ id_type: "DOMESTIC_RESIDENCE", recorded: true, sex_derived: "FEMALE" });
  } finally {
    put.mockRestore();
    stepUp.mockRestore();
  }
});
