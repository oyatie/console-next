import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { lostAnswer } from "./api";

test("a typed transport failure checks the existing import job", () => {
  expect(lostAnswer(new ApiError(0, "command_unknown", ""))).toBe(true);
  expect(lostAnswer(new TypeError("Failed to fetch"))).toBe(true);
  expect(lostAnswer(new ApiError(408, "request_timeout", ""))).toBe(true);
  expect(lostAnswer(new ApiError(503, "service_unavailable", ""))).toBe(true);
});

test("answered refusals never masquerade as a lost import response", () => {
  for (const [status, code] of [[403, "forbidden"], [409, "dry_run_digest_mismatch"], [503, "import_apply_busy"], [503, "import_run_expired"]] as const) {
    expect(lostAnswer(new ApiError(status, code, ""))).toBe(false);
  }
});
