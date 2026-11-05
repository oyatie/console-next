// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";

import { codeqlAlertFailures, fetchOpenCodeqlAlerts } from "./check-codeql-alerts.mjs";

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
const registry = (entries = [exception()]) => ({ schema: "codeql-alert-exceptions-v1", entries });

test.each(["high", "critical"])("rejects an untriaged %s Rust alert", (severity) => {
  const finding = alert({ number: 999, rule: { id: "rust/new-finding", security_severity_level: severity } });
  expect(codeqlAlertFailures([finding], registry(), "rust", "2026-11-03")).toContain(
    `untriaged ${severity} Rust alert #999: rust/new-finding at ${path}`,
  );
});

test("rejects an untriaged high JavaScript alert", () => {
  const finding = alert({
    number: 9,
    rule: { id: "js/incomplete-url-substring-sanitization", security_severity_level: "high" },
  });
  expect(codeqlAlertFailures([finding], registry([]), "javascript-typescript", "2026-11-03")).toContain(
    `untriaged high JavaScript alert #9: js/incomplete-url-substring-sanitization at ${path}`,
  );
});

test("accepts only an exact live exception and ignores other scanners and languages", () => {
  const alerts = [
    alert(),
    alert({ number: 8, rule: { id: "py/clear-text-logging-sensitive-data", security_severity_level: "high" } }),
    alert({ number: 21, tool: { name: "Other scanner" } }),
  ];
  expect(codeqlAlertFailures(alerts, registry(), "rust", "2026-11-03")).toEqual([]);
  expect(codeqlAlertFailures([alert({ most_recent_instance: { location: { path: "moved.rs" } } })], registry(), "rust", "2026-11-03"))
    .toContain("exception #20 no longer matches rust/cleartext-logging at moved.rs");
});

test("rejects an exception after its alert closes or is dismissed", () => {
  expect(codeqlAlertFailures([], registry(), "rust", "2026-11-03")).toContain("stale exception #20");
});

test.each([
  [{ schema: "wrong", entries: [] }, "schema"],
  [registry([exception(), exception()]), "duplicate alert #20"],
  [registry([exception({ owner: "" })]), "missing owner"],
  [registry([exception({ rule: "python/cleartext-logging" })]), "unsupported CodeQL rule"],
  [registry([exception({ path: "/absolute.rs" })]), "repository-relative"],
  [registry([exception({ path: "../outside.rs" })]), "repository-relative"],
  [registry([exception({ expires_on: "2026-02-30" })]), "invalid expiry"],
  [registry([exception({ expires_on: "2026-11-03" })]), "expired"],
  [registry([exception({ expires_on: "2027-01-01" })]), "exceeds 30-day TTL"],
] as const)("fails closed on an invalid exception registry: %s", (document, message) => {
  expect(codeqlAlertFailures([alert()], document, "rust", "2026-11-03").join("\n")).toContain(message);
});

test("rejects an invalid gate date", () => {
  expect(codeqlAlertFailures([alert()], registry(), "rust", "not-a-date")).toContain("invalid gate date not-a-date");
});

test("rejects closed and unexpected-severity alerts as malformed API input", () => {
  expect(codeqlAlertFailures([alert({ state: "closed" })], registry(), "rust", "2026-11-03"))
    .toContain("malformed code-scanning alert at index 0");
  expect(codeqlAlertFailures([
    alert({ rule: { id: "rust/cleartext-logging", security_severity_level: "medium" } }),
  ], registry(), "rust", "2026-11-03")).toContain("unexpected CodeQL alert severity for #20: medium");
});

test.each([
  ["javascript-typescript", "js/incomplete-url-substring-sanitization", "rust", "rust/cleartext-logging"],
  ["rust", "rust/cleartext-logging", "javascript-typescript", "js/incomplete-url-substring-sanitization"],
])("%s gates only its own alerts and exception entries", (language, rule, otherLanguage, otherRule) => {
  const own = alert({ rule: { id: rule, security_severity_level: "high" } });
  const document = registry([
    exception({ rule }),
    exception({ number: 88, rule: otherRule, expires_on: "2026-11-02" }),
  ]);
  for (const category of [undefined, `/language:${otherLanguage}`]) {
    const foreign = alert({
      number: 99,
      rule: { id: otherRule, security_severity_level: "critical" },
      most_recent_instance: { category, location: { path } },
    });
    expect(codeqlAlertFailures([own, foreign], document, language, "2026-11-03")).toEqual([]);
    expect(codeqlAlertFailures([own, { ...foreign, state: "dismissed" }], document, language, "2026-11-03")).toEqual([]);
  }
  expect(codeqlAlertFailures([], document, language, "2026-11-03")).toEqual(["stale exception #20"]);
  expect(codeqlAlertFailures([own], registry([]), language, "2026-11-03").join("\n"))
    .toContain("untriaged high");
  const categorized = alert({
    rule: { id: "shared/query", security_severity_level: "high" },
    most_recent_instance: { category: `/language:${language}`, location: { path } },
  });
  expect(codeqlAlertFailures([categorized], registry([]), language, "2026-11-03").join("\n"))
    .toContain("untriaged high");
  expect(codeqlAlertFailures([categorized], registry([]), otherLanguage, "2026-11-03")).toEqual([]);
});

test.each([undefined, "python"])("rejects a missing or unsupported matrix language: %s", (language) => {
  expect(codeqlAlertFailures([], registry([]), language, "2026-11-03"))
    .toEqual(["CODEQL_LANGUAGE must be javascript-typescript or rust"]);
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

  const invalid = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
  await expect(fetchOpenCodeqlAlerts("https://api.github.test", "owner/repo", "refs/heads/dev", "token", invalid))
    .rejects.toThrow("CodeQL alerts API returned an invalid response");
});

test("rejects untrusted API URLs and refs before fetching", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as Response);
  await expect(fetchOpenCodeqlAlerts("http://api.github.test", "owner/repo", "refs/heads/dev", "token", fetcher))
    .rejects.toThrow("GITHUB_API_URL must use HTTPS");
  await expect(fetchOpenCodeqlAlerts("https://api.github.test", "owner/repo", "refs/tags/v1", "token", fetcher))
    .rejects.toThrow("CodeQL gate requires a branch ref and GH_TOKEN");
  expect(fetcher).not.toHaveBeenCalled();
});

test("the CLI fails closed without its trusted workflow inputs", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: {} });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CODEQL_ALERT_EXCEPTIONS is required");
});
