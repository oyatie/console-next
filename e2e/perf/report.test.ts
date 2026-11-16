// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { comparison } from "./report";

test("the PR comparison pairs only cold tails and preserves failed and missing evidence", () => {
  const row = { route: "/people", cache: "cold", protocol: "http/1.1", lcp_p95_ms: 2500, status: "fail", sample_count: 20 };
  expect(comparison([row, { ...row, protocol: "h2", lcp_p95_ms: 1500, status: "pass" },
    { ...row, cache: "warm", lcp_p95_ms: 1 }, { ...row, route: "/org", lcp_p95_ms: null, status: "unknown", sample_count: 0 }]))
    .toContain("| /people | 2500 (fail, n=20) | 1500 (pass, n=20) |");
  expect(comparison([{ ...row, lcp_p95_ms: null, status: "unknown", sample_count: 0 }]))
    .toContain("| /people | unknown (unknown, n=0) | unknown (missing) |");
});
