import { expect, test, vi } from "vitest";
import { api, ApiError } from "@console/api";
import { lostAnswer, previewRollback, requestRollback, runQuery, runsQuery } from "./api";

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
    expect(runQuery("run-1").queryKey).not.toEqual(runQuery("run-2").queryKey);
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
    expect(post).toHaveBeenLastCalledWith("/api/v1/employee-import-runs/{run_id}/rollback", expect.objectContaining({ params: { path: { run_id: "run-1" }, header: { "Idempotency-Key": "rollback-intent-key" } }, body }));
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
