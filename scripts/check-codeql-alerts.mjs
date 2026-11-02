#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PAGE_SIZE = 100;
const MAX_EXCEPTION_DAYS = 30;
const SECURITY_SEVERITIES = ["high", "critical"];

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function rustAlertFailures(alerts, registry, today = new Date().toISOString().slice(0, 10)) {
  const failures = [];
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  if (registry?.schema !== "codeql-rust-alert-exceptions-v1" || !Array.isArray(registry?.entries)) {
    failures.push("exception registry has an invalid schema or entries list");
  }
  if (!validDate(today)) failures.push(`invalid gate date ${today}`);
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const byNumber = new Map();
  for (const [index, entry] of entries.entries()) {
    const label = `exception[${index}]`;
    if (!entry || typeof entry !== "object") {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (!Number.isInteger(entry.number) || entry.number <= 0) failures.push(`${label} has an invalid alert number`);
    for (const field of ["rule", "path", "owner", "reason", "expires_on"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) failures.push(`${label} missing ${field}`);
    }
    if (typeof entry.rule === "string" && !entry.rule.startsWith("rust/")) failures.push(`${label} is not a Rust rule`);
    if (typeof entry.path === "string" && (entry.path.startsWith("/") || entry.path.split("/").includes(".."))) {
      failures.push(`${label} path must be repository-relative`);
    }
    if (!validDate(entry.expires_on)) failures.push(`${label} has an invalid expiry`);
    else {
      const expiry = Date.parse(`${entry.expires_on}T00:00:00Z`);
      if (expiry <= todayTime) failures.push(`${label} expired on ${entry.expires_on}`);
      if (expiry - todayTime > MAX_EXCEPTION_DAYS * 864e5) failures.push(`${label} exceeds ${MAX_EXCEPTION_DAYS}-day TTL`);
    }
    if (byNumber.has(entry.number)) failures.push(`duplicate alert #${entry.number}`);
    else byNumber.set(entry.number, entry);
  }

  if (!Array.isArray(alerts)) return [...failures, "code-scanning response is not an array"];
  for (const [index, alert] of alerts.entries()) {
    const number = alert?.number;
    const rule = alert?.rule?.id;
    const severity = alert?.rule?.security_severity_level;
    const tool = alert?.tool?.name;
    const path = alert?.most_recent_instance?.location?.path;
    if (!Number.isInteger(number) || typeof rule !== "string" || typeof severity !== "string"
      || typeof tool !== "string" || typeof path !== "string" || alert?.state !== "open") {
      failures.push(`malformed code-scanning alert at index ${index}`);
      continue;
    }
    if (tool !== "CodeQL" || !rule.startsWith("rust/")) continue;
    if (!SECURITY_SEVERITIES.includes(severity)) {
      failures.push(`unexpected Rust alert severity for #${number}: ${severity}`);
      continue;
    }
    const allowed = byNumber.get(number);
    if (!allowed) failures.push(`untriaged ${severity} Rust alert #${number}: ${rule} at ${path}`);
    else if (allowed.rule !== rule || allowed.path !== path) failures.push(`exception #${number} no longer matches ${rule} at ${path}`);
  }
  return failures;
}

export async function fetchOpenCodeqlAlerts(apiUrl, repository, ref, token, fetcher = globalThis.fetch) {
  if (!/^https:\/\//.test(apiUrl ?? "")) throw new Error("GITHUB_API_URL must use HTTPS");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid");
  if (!ref?.startsWith("refs/heads/") || !token) throw new Error("CodeQL gate requires a branch ref and GH_TOKEN");
  const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/code-scanning/alerts`;
  const alerts = [];
  for (const severity of SECURITY_SEVERITIES) {
    for (let page = 1; ; page += 1) {
      const url = new URL(endpoint);
      for (const [key, value] of Object.entries({ state: "open", severity, ref, per_page: PAGE_SIZE, page })) {
        url.searchParams.set(key, String(value));
      }
      const response = await fetcher(url, { headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "console-codeql-gate",
        "X-GitHub-Api-Version": "2022-11-28",
      } });
      if (!response.ok) throw new Error(`CodeQL alerts API returned ${response.status}`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error("CodeQL alerts API returned an invalid response");
      alerts.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
  }
  return alerts;
}

async function main() {
  const registryPath = process.env.CODEQL_ALERT_EXCEPTIONS;
  if (!registryPath) throw new Error("CODEQL_ALERT_EXCEPTIONS is required");
  const registry = JSON.parse(readFileSync(resolve(registryPath), "utf8"));
  const alerts = await fetchOpenCodeqlAlerts(
    process.env.GITHUB_API_URL,
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_REF,
    process.env.GH_TOKEN,
  );
  const failures = rustAlertFailures(alerts, registry);
  if (failures.length) throw new Error(`CodeQL Rust alert gate failed:\n- ${failures.join("\n- ")}`);
  const count = alerts.filter((alert) => alert?.tool?.name === "CodeQL" && alert?.rule?.id?.startsWith("rust/")).length;
  console.log(`CodeQL: ${count} open high/critical Rust alert(s), all triaged`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
