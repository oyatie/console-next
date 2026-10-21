import { expect, test, vi } from "vitest";
import { api, ApiError } from "@console/api";
import { lostAnswer, runQuery, runsQuery } from "./api";

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
