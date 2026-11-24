// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { comparison } from "./report";

test("the PR comparison pairs only cold tails and preserves failed and missing evidence", () => {
  const row = { route: "/people", cache: "cold", protocol: "http/1.1", lcp_p95_ms: 2500, status: "fail", sample_count: 20 };
  expect(comparison([{ ...row, cache: "warm", lcp_p95_ms: 1 }, row, { ...row, protocol: "h2", lcp_p95_ms: 1500, status: "pass" },
    { ...row, cache: "warm", lcp_p95_ms: 1 }, { ...row, route: "/org", lcp_p95_ms: null, status: "unknown", sample_count: 0 }]))
    .toContain("| /people | 2500 (fail, n=20) | 1500 (pass, n=20) |");
  expect(comparison([{ ...row, lcp_p95_ms: null, status: "unknown", sample_count: 0 }]))
    .toContain("| /people | unknown (unknown, n=0) | unknown (missing) |");
});

test("unknown numeric tails are not presented as valid measurements", () => {
  expect(comparison([{ route: "/", cache: "cold", protocol: "h2", lcp_p95_ms: 50, status: "unknown", sample_count: 1 }]))
    .toContain("unknown (unknown, n=1)");
});

test("the report reads production and comparison arrays", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perf-report-"));
  try {
    const row = { route: "/", cache: "cold", protocol: "h2", lcp_p95_ms: 100, status: "pass", sample_count: 20 };
    const file = path.join(dir, "route-load.json");
    writeFileSync(file, JSON.stringify({ rows: [row], comparison: [{ ...row, protocol: "http/1.1", lcp_p95_ms: 3000, status: "fail" }] }));
    expect(execFileSync(process.execPath, ["e2e/perf/report.ts", file], { encoding: "utf8" }))
      .toContain("| / | 3000 (fail, n=20) | 100 (pass, n=20) |");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the waterfall excerpt belongs to the cold p95 sample", () => {
  const row = { route: "/", cache: "cold", protocol: "h2", lcp_p95_ms: 100, status: "pass", sample_count: 20 };
  expect(comparison([{ ...row, samples: [
    { lcp_ms: 50, waterfall_summary: { entries: 1, max_queue_ms: 0, last_response_end_ms: 40 } },
    { lcp_ms: 100, waterfall_summary: { entries: 200, max_queue_ms: 10, last_response_end_ms: 90 } },
  ] }])).toContain("| / | h2 | 200 | 10 | 90 |");
});

test("the job summary explains an omitted transport once and keeps the gated cold tails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perf-report-"));
  try {
    const row = { route: "/", cache: "cold", protocol: "h2", lcp_p95_ms: 110, status: "pass", sample_count: 20 };
    const file = path.join(dir, "route-load.json");
    writeFileSync(file, JSON.stringify({ transports: ["h2"], rows: [row, { ...row, route: "/people", status: "fail" }], comparison: [] }));
    const summary = execFileSync(process.execPath, ["e2e/perf/report.ts", file], { encoding: "utf8" });
    expect(summary.trim().split("\n")).toEqual([
      "HTTP/1.1 not measured on this run", "",
      "| Route | HTTP/2 cold p95 LCP (ms) |", "| --- | --- |",
      "| / | 110 (pass, n=20) |", "| /people | 110 (fail, n=20) |",
    ]);

    writeFileSync(file, JSON.stringify({ transports: ["http/1.1", "h2"], rows: [row], comparison: [] }));
    expect(execFileSync(process.execPath, ["e2e/perf/report.ts", file], { encoding: "utf8" }))
      .toContain("| / | unknown (missing) | 110 (pass, n=20) |");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
