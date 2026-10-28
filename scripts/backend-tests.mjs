// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripRustCommentsAndStringLiterals } from "./check-executed-tests-cfg.mjs";

export function databaseTests(sources) {
  const database = new Set(), ordinary = new Set();
  for (const source of sources) {
    const code = stripRustCommentsAndStringLiterals(source);
    const functions = /((?:#\s*\[[^\]]*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(?:r#)?(\$?\w+)/g;
    const kind = (attributes) => /#\s*\[\s*sqlx\s*::\s*test\b/.test(attributes) ? database
      : /#\s*\[\s*(?:tokio\s*::\s*)?test\s*(?:\]|\()/.test(attributes) ? ordinary : null;
    for (const [, attributes, name] of code.matchAll(functions)) {
      if (!name.startsWith("$")) kind(attributes)?.add(name);
    }
    for (const macro of code.matchAll(/macro_rules!\s*(\w+)\s*\{/g)) {
      let end = macro.index + macro[0].length, depth = 1;
      const start = end;
      while (depth && end < code.length) {
        if (code[end] === "{") depth++;
        if (code[end++] === "}") depth--;
      }
      const body = code.slice(start, end - 1);
      for (const [, attributes, name] of body.matchAll(functions)) {
        const target = kind(attributes);
        if (!target || !name.startsWith("$")) continue;
        assert.ok(new RegExp(`^\\s*\\(\\s*\\${name}\\s*:\\s*ident\\b`).test(body), `unsupported test macro: ${macro[1]}`);
        for (const invocation of code.matchAll(new RegExp(`\\b${macro[1]}!\\s*[({]\\s*(?:r#)?(\\w+)`, "g"))) target.add(invocation[1]);
      }
    }
  }
  // Refuse name collisions rather than silently exclude an ordinary test in another module.
  for (const name of database) assert.ok(!ordinary.has(name), `ambiguous database test name: ${name}`);
  return database;
}

const matcher = (value) => `=${value.replace(/[\\),]/g, "\\$&")}`;
export function classifyTests(list, byPackage) {
  const selected = [], database = [], ignored = [], excluded = [], featureGatedDatabase = [];
  const listed = new Map();
  for (const suite of Object.values(list["rust-suites"])) {
    assert.equal(suite.status, "listed", `${suite["binary-id"]}: tests were not listed`);
    const names = byPackage.get(suite["package-id"]);
    assert.ok(names, `missing source inventory for ${suite["package-id"]}`);
    const cases = Object.entries(suite.testcases), db = [];
    for (const [name, info] of cases) {
      if (!listed.has(suite["package-id"])) listed.set(suite["package-id"], new Set());
      listed.get(suite["package-id"]).add(name.split("::").at(-1));
      const id = [suite["binary-id"], name];
      const requiresDatabase = names.has(name.split("::").at(-1));
      if (requiresDatabase) db.push(name);
      if (info.ignored) ignored.push(id);
      else (requiresDatabase ? database : selected).push(id);
    }
    const binary = `binary_id(${matcher(suite["binary-id"])})`;
    if (db.length) excluded.push(db.length === cases.length ? binary : `(${binary} & (${db.map((name) => `test(${matcher(name)})`).join(" | ")}))`);
  }
  // Source declarations include SQLx tests compiled out by features such as test-postgres.
  for (const [pkg, names] of byPackage) for (const name of names) {
    if (!listed.get(pkg)?.has(name)) featureGatedDatabase.push([pkg, name]);
  }
  assert.ok(selected.length, "zero non-database tests discovered");
  const filter = excluded.length ? `not (${excluded.join(" | ")})` : "all()";
  assert.ok(Buffer.byteLength(filter) < 128 * 1024, "nextest filter exceeds Linux's single-argument limit");
  return { selected, database, ignored, featureGatedDatabase, filter };
}

const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity])]));
export function verifyJUnit(xml, expected) {
  const root = xml.match(/<testsuites\s[^>]*>/)?.[0];
  assert.ok(root && xml.includes("</testsuites>"), "missing or incomplete nextest JUnit report");
  const counts = attributes(root);
  assert.equal(Number(counts.tests), expected.length, "JUnit count differs from discovered non-database tests");
  assert.equal(Number(counts.failures), 0, "JUnit reports failing tests");
  assert.equal(Number(counts.errors), 0, "JUnit reports test errors");
  assert.doesNotMatch(xml, /<skipped\b/, "selected tests were skipped");
  const actual = [...xml.matchAll(/<testcase\s[^>]*>/g)].map(([tag]) => {
    const { classname, name } = attributes(tag);
    return JSON.stringify([classname, name]);
  });
  assert.deepEqual(actual.sort(), expected.map((id) => JSON.stringify(id)).sort(), "JUnit identities differ from discovered non-database tests");
  return actual.length;
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return ["target", "node_modules", ".git"].includes(entry.name) ? [] : sources(file);
    return entry.name.endsWith(".rs") ? [readFileSync(file, "utf8")] : [];
  });
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const env = { ...process.env, SQLX_OFFLINE: "true" };
  for (const key of Object.keys(env)) if (key.endsWith("DATABASE_URL") || /^PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)/.test(key)) delete env[key];
  const options = { cwd: path.join(root, "backend"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const cargoJSON = (args) => JSON.parse(execFileSync("cargo", args, { ...options, stdio: ["ignore", "pipe", "inherit"] }));
  const metadata = cargoJSON(["metadata", "--no-deps", "--locked", "--format-version", "1"]);
  const args = ["--workspace", "--locked", "--profile", "ci", "--config-file", path.join(root, ".config/nextest.toml"), "--ignore-default-filter"];
  const list = cargoJSON(["nextest", "list", ...args, "--message-format", "json"]);
  const byPackage = new Map(metadata.packages.map((pkg) => [pkg.id, databaseTests(sources(path.dirname(pkg.manifest_path)))]));
  const inventory = classifyTests(list, byPackage);
  const report = path.join(metadata.workspace_root, "target/nextest/ci");
  mkdirSync(report, { recursive: true });
  writeFileSync(path.join(report, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  rmSync(path.join(report, "junit.xml"), { force: true });
  const summary = (text) => {
    console.log(text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text + "\n");
  };
  const deferred = inventory.database.length + inventory.ignored.length + inventory.featureGatedDatabase.length;
  summary(`Rust tests discovered: ${inventory.selected.length} non-database; ${deferred} deferred (${inventory.database.length} listed database tests, ${inventory.ignored.length} explicitly ignored, ${inventory.featureGatedDatabase.length} feature-gated database source declarations, including test-postgres).`);
  for (const [binary, name] of inventory.ignored) summary(`- Ignored by source attribute: \`${binary} / ${name}\``);
  const started = performance.now();
  const result = spawnSync("cargo", ["nextest", "run", ...args, "--no-fail-fast", "--run-ignored", "default", "-E", inventory.filter], { ...options, stdio: "inherit" });
  assert.ifError(result.error);
  const xml = readFileSync(path.join(report, "junit.xml"), "utf8");
  const counts = attributes(xml.match(/<testsuites\s[^>]*>/)?.[0] ?? "");
  summary(`JUnit results: ${counts.tests ?? "missing"} executed, ${counts.failures ?? "missing"} failures, ${counts.errors ?? "missing"} errors.`);
  const executed = verifyJUnit(xml, inventory.selected);
  assert.equal(result.status, 0, `cargo nextest failed (${result.status ?? result.signal})`);
  summary(`JUnit verified: ${executed}/${inventory.selected.length} non-database tests passed in ${((performance.now() - started) / 1000).toFixed(1)}s; no selected tests skipped.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
