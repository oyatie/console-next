// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";

import { fetchOpenCodeqlAlerts, rustAlertFailures } from "./check-codeql-alerts.mjs";

const script = resolve("scripts/check-codeql-alerts.mjs");
const path = "backend/crates/platform/storage/src/lib.rs";
const alert = (overrides: Record<string, unknown> = {}) => ({
  number: 20,
  state: "open",
  rule: { id: "rust/cleartext-logging", security_severity_level: "high" },
  tool: { name: "CodeQL" },
  most_recent_instance: { location: { path } },
  ...overrides,
});
const exception = (overrides: Record<string, unknown> = {}) => ({
  number: 20,
  rule: "rust/cleartext-logging",
  path,
  owner: "Security",
  reason: "Test-only assertion over generated identifiers; no runtime log sink.",
  expires_on: "2026-11-17",
  ...overrides,
});
const registry = (entries = [exception()]) => ({ schema: "codeql-rust-alert-exceptions-v1", entries });

test.each(["high", "critical"])("rejects an untriaged %s Rust alert", (severity) => {
  const finding = alert({ number: 999, rule: { id: "rust/new-finding", security_severity_level: severity } });
  expect(rustAlertFailures([finding], registry(), "2026-11-03")).toContain(
    `untriaged ${severity} Rust alert #999: rust/new-finding at ${path}`,
  );
});

test("accepts only an exact live exception and ignores other scanners and languages", () => {
  const alerts = [
    alert(),
    alert({ number: 9, rule: { id: "js/incomplete-url-substring-sanitization", security_severity_level: "high" } }),
    alert({ number: 21, tool: { name: "Other scanner" } }),
  ];
  expect(rustAlertFailures(alerts, registry(), "2026-11-03")).toEqual([]);
  expect(rustAlertFailures([alert({ most_recent_instance: { location: { path: "moved.rs" } } })], registry(), "2026-11-03"))
    .toContain("exception #20 no longer matches rust/cleartext-logging at moved.rs");
});

test.each([
  [{ schema: "wrong", entries: [] }, "schema"],
  [registry([exception(), exception()]), "duplicate alert #20"],
  [registry([exception({ owner: "" })]), "missing owner"],
  [registry([exception({ expires_on: "2026-02-30" })]), "invalid expiry"],
  [registry([exception({ expires_on: "2026-11-03" })]), "expired"],
  [registry([exception({ expires_on: "2027-01-01" })]), "exceeds 30-day TTL"],
] as const)("fails closed on an invalid exception registry: %s", (document, message) => {
  expect(rustAlertFailures([alert()], document, "2026-11-03").join("\n")).toContain(message);
});

test("the repository registry exactly covers the eleven triaged Rust alerts", () => {
  const document = JSON.parse(readFileSync(".github/codeql/rust-alert-exceptions.json", "utf8"));
  expect(document.entries.map((entry: { number: number }) => entry.number)).toEqual([20, 24, 25, 31, 50, 53, 54, 55, 57, 58, 68]);
  const alerts = document.entries.map((entry: { number: number; rule: string; path: string }) => alert({
    number: entry.number,
    rule: { id: entry.rule, security_severity_level: entry.number >= 57 ? "critical" : "high" },
    most_recent_instance: { location: { path: entry.path } },
  }));
  expect(rustAlertFailures(alerts, document, "2026-11-03")).toEqual([]);
});

test("fetches every high and critical page and fails closed on an API error", async () => {
  const calls: URL[] = [];
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    calls.push(url);
    const severity = url.searchParams.get("severity");
    const page = Number(url.searchParams.get("page"));
    const body = severity === "high" && page === 1
      ? Array.from({ length: 100 }, (_, number) => alert({ number: number + 1 }))
      : severity === "critical" && page === 1 ? [alert({ number: 101 })] : [];
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  const findings = await fetchOpenCodeqlAlerts("https://api.github.test", "owner/repo", "refs/heads/dev", "token", fetcher);
  expect(findings).toHaveLength(101);
  expect(calls.map((url) => [url.searchParams.get("severity"), url.searchParams.get("page")])).toEqual([
    ["high", "1"], ["high", "2"], ["critical", "1"],
  ]);
  expect(calls.every((url) => url.searchParams.get("state") === "open" && url.searchParams.get("ref") === "refs/heads/dev")).toBe(true);

  const denied = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
  await expect(fetchOpenCodeqlAlerts("https://api.github.test", "owner/repo", "refs/heads/dev", "token", denied))
    .rejects.toThrow("CodeQL alerts API returned 403");
});

test("the CLI fails closed without its trusted workflow inputs", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: {} });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CODEQL_ALERT_EXCEPTIONS is required");
});
