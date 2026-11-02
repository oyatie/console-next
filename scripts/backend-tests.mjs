// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  const selected = [], database = [], ignored = [], ignoredDatabase = [], excluded = [], featureGatedDatabase = [];
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
      if (info.ignored) {
        ignored.push(id);
        if (requiresDatabase) ignoredDatabase.push(id);
      }
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
  return { selected, database, ignored, ignoredDatabase, featureGatedDatabase, filter };
}

const identity = (id) => JSON.stringify(id);
function exactFilter(tests) {
  assert.ok(tests.length, "zero database tests selected");
  const binaries = new Map();
  for (const [binary, name] of tests) (binaries.get(binary) ?? binaries.set(binary, []).get(binary)).push(name);
  const filter = [...binaries].map(([binary, names]) => `(binary_id(${matcher(binary)}) & (${names.map((name) => `test(${matcher(name)})`).join(" | ")}))`).join(" | ");
  assert.ok(Buffer.byteLength(filter) < 128 * 1024, "nextest filter exceeds Linux's single-argument limit");
  return filter;
}

export function planDatabaseTests(tests, timings = {}, shardCount = 4) {
  assert.ok(Number.isInteger(shardCount) && shardCount >= 1 && shardCount <= 4, "database shard count must be 1..4");
  assert.ok(tests.length >= shardCount, "every database shard must select a test");
  const keys = tests.map(identity);
  assert.equal(new Set(keys).size, keys.length, "duplicate database test identity");
  const measured = timings.tests ?? {};
  assert.ok(measured && typeof measured === "object" && !Array.isArray(measured), "invalid database timings");
  for (const seconds of Object.values(measured)) assert.ok(Number.isFinite(seconds) && seconds >= 0, "invalid database timing");
  const known = keys.flatMap((key) => Object.hasOwn(measured, key) ? [measured[key]] : []).sort((a, b) => a - b);
  const fallback = known.length ? known[known.length >> 1] : 1;
  const bins = Array.from({ length: shardCount }, (_, index) => ({ id: index + 1, tests: [], seconds: 0 }));
  const ordered = tests.map((id) => ({ id, key: identity(id), seconds: measured[identity(id)] ?? fallback }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  for (const entry of ordered) {
    const bin = bins.reduce((left, right) => right.seconds < left.seconds ? right : left);
    bin.tests.push(entry.id);
    bin.seconds += entry.seconds;
  }
  for (const bin of bins) bin.seconds = Math.round(bin.seconds * 1000) / 1000;
  return { version: 1, tests, shards: bins };
}

export function validateIgnoredTests(sources, today = new Date().toISOString().slice(0, 10)) {
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/, "invalid ignore policy date");
  let count = 0;
  for (const source of sources) for (const match of source.matchAll(/^[ \t]*#\s*\[([\s\S]*?)\][ \t]*$/gm)) {
    if (!/\bignore\b/.test(match[1])) continue;
    count++;
    const name = source.slice(match.index + match[0].length).match(/(?:async\s+)?fn\s+(?:r#)?(\w+)/)?.[1] ?? "unknown test";
    const adjacent = source.slice(0, match.index).match(/\/\/\s*ignore-policy:\s*([^\n]+)\n\s*$/)?.[1];
    const policy = match[1].match(/\bignore\s*=\s*"([^"]+)"/)?.[1] ?? adjacent;
    const fields = policy?.match(/^owner=([^;]+);\s*reason=([^;]+);\s*expires=(\d{4}-\d{2}-\d{2})$/);
    const expiry = fields?.[3], timestamp = Date.parse(`${expiry}T00:00:00Z`);
    assert.ok(fields?.[1].trim() && fields[2].trim() && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === expiry && expiry >= today, `${name}: invalid or expired ignore policy`);
  }
  return count;
}

const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity])]));
const junitCases = (xml) => [...xml.matchAll(/<testcase\s[^>]*>/g)].map(([tag]) => {
  const values = attributes(tag);
  return { id: [values.classname, values.name], seconds: Number(values.time ?? 0) };
});
export function verifyJUnit(xml, expected) {
  const root = xml.match(/<testsuites\s[^>]*>/)?.[0];
  assert.ok(root && xml.includes("</testsuites>"), "missing or incomplete nextest JUnit report");
  const counts = attributes(root);
  assert.equal(Number(counts.tests), expected.length, "JUnit count differs from selected tests");
  assert.equal(Number(counts.failures), 0, "JUnit reports failing tests");
  assert.equal(Number(counts.errors), 0, "JUnit reports test errors");
  assert.doesNotMatch(xml, /<skipped\b/, "selected tests were skipped");
  const actual = junitCases(xml).map(({ id }) => identity(id));
  assert.deepEqual(actual.sort(), expected.map(identity).sort(), "JUnit identities differ from selected tests");
  return actual.length;
}

export function collectDatabaseResults(plan, reports) {
  assert.equal(plan.version, 1, "invalid database plan");
  const expected = plan.shards.flatMap((shard) => shard.tests);
  assert.deepEqual(expected.map(identity).sort(), plan.tests.map(identity).sort(), "database plan identities differ");
  let tests = 0, failures = 0, errors = 0;
  const cases = [];
  for (const xml of reports) {
    const root = xml.match(/<testsuites\s[^>]*>/)?.[0];
    assert.ok(root && xml.includes("</testsuites>"), "missing or incomplete nextest JUnit report");
    const counts = attributes(root);
    tests += Number(counts.tests);
    failures += Number(counts.failures);
    errors += Number(counts.errors);
    assert.doesNotMatch(xml, /<skipped\b/, "database tests were skipped");
    cases.push(...junitCases(xml));
  }
  assert.equal(tests, cases.length, "JUnit count differs from database case records");
  assert.deepEqual(cases.map(({ id }) => identity(id)).sort(), expected.map(identity).sort(), "database JUnit identities differ from the plan");
  const measured = {};
  for (const item of cases) {
    assert.ok(Number.isFinite(item.seconds) && item.seconds >= 0, "invalid database JUnit duration");
    measured[identity(item.id)] = item.seconds;
  }
  return {
    counts: { tests, passed: tests - failures - errors, failed: failures + errors },
    timings: { version: 1, tests: Object.fromEntries(Object.entries(measured).sort(([a], [b]) => a.localeCompare(b))) },
  };
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return ["target", "node_modules", ".git"].includes(entry.name) ? [] : sources(file);
    return entry.name.endsWith(".rs") ? [readFileSync(file, "utf8")] : [];
  });
}

// Partition build targets, not test execution: linking integration binaries dominates hosted time.
export function buildTargets(metadata, index, count) {
  if (index === undefined && count === undefined) return ["--workspace"];
  const shard = Number(index), total = Number(count);
  assert.ok(Number.isInteger(shard) && Number.isInteger(total) && shard >= 1 && shard <= total, "invalid nextest shard");
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter(pkg => members.has(pkg.id));
  assert.ok(packages.every(pkg => pkg.targets.every(target => !target.test || target.kind.some(kind => ["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro", "bin", "test"].includes(kind)))), "unsupported nextest test target");
  const features = new Map(metadata.resolve?.nodes.map(node => [node.id, new Set(node.features)]));
  const enabled = new Set(), disabled = new Set();
  for (const pkg of packages) for (const target of pkg.targets.filter(target => target.kind.includes("test") && target.test !== false)) {
    const required = target["required-features"] ?? [];
    assert.ok(!required.length || features.has(pkg.id), `missing resolved features for ${pkg.id}`);
    (required.every(feature => features.get(pkg.id).has(feature)) ? enabled : disabled).add(target.name);
  }
  for (const name of enabled) assert.ok(!disabled.has(name), `ambiguous feature-gated test target: ${name}`);
  const targets = [...enabled].sort();
  assert.ok(total <= targets.length, "nextest shard has no integration targets");
  return ["--workspace", ...(shard === 1 ? ["--lib", "--bins"] : []),
    ...targets.filter((_, i) => i % total === shard - 1).flatMap(name => ["--test", name])];
}

const summary = (text, env = process.env) => {
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text + "\n");
};

function cli() {
  const args = process.argv.slice(2);
  if (args[0] === "--collect") {
    assert.ok(args.length >= 4, "usage: --collect <plan> <timings-output> <junit...>");
    return { collect: args.slice(1) };
  }
  let database = false, shard = "1/1", timings;
  while (args.length) {
    const option = args.shift();
    if (option === "--db") database = true;
    else if (option === "--shard") shard = args.shift();
    else if (option === "--timings") timings = args.shift();
    else assert.fail(`unknown backend test option: ${option}`);
  }
  const parsed = shard?.match(/^(\d+)\/(\d+)$/);
  assert.ok(parsed, "database shard must be N/TOTAL");
  const number = Number(parsed[1]), total = Number(parsed[2]);
  assert.ok(number >= 1 && number <= total && total <= 4, "database shard must be within 1..4");
  assert.ok(database || shard === "1/1" && !timings, "database shard options require --db");
  return { database, shard: number, total, timings };
}

function main() {
  const started = performance.now();
  const root = path.resolve(import.meta.dirname, "..");
  const command = cli();
  if (command.collect) {
    const [planFile, output, ...reports] = command.collect;
    const result = collectDatabaseResults(JSON.parse(readFileSync(planFile, "utf8")), reports.map((file) => readFileSync(file, "utf8")));
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(result.timings, null, 2) + "\n");
    summary(`Database JUnit verified: ${result.counts.tests} run, ${result.counts.passed} passed, ${result.counts.failed} failed; every planned shard accounted for.`);
    return;
  }
  const env = { ...process.env, SQLX_OFFLINE: "true" };
  if (command.database) assert.ok(env.DATABASE_URL, "--db requires DATABASE_URL");
  else for (const key of Object.keys(env)) if (key.endsWith("DATABASE_URL") || /^PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)/.test(key)) delete env[key];
  const options = { cwd: path.join(root, "backend"), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const cargoJSON = (args) => {
    const result = spawnSync("cargo", args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `cargo ${args.slice(0, 2).join(" ")} failed (${result.status ?? result.signal})`);
    return JSON.parse(result.stdout);
  };
  const features = command.database ? ["--features", "test-postgres,console-app/full,console-app/e2e-test-support,console-app/dev-auth"] : [];
  const metadata = cargoJSON(["metadata", "--locked", ...features, "--format-version", "1"]);
  const targets = command.database ? ["--workspace"] : buildTargets(metadata, env.NEXTEST_SHARD, env.NEXTEST_SHARDS);
  const nextestArgs = (selectedFeatures = []) => [...targets, "--locked", ...selectedFeatures, "--profile", "ci", "--config-file", path.join(root, ".config/nextest.toml"), "--ignore-default-filter"];
  const defaultArgs = nextestArgs(), featuredArgs = nextestArgs(features);
  const list = cargoJSON(["nextest", "list", ...(command.database ? featuredArgs : defaultArgs), "--message-format", "json"]);
  const packageSources = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id)).map((pkg) => [pkg, sources(path.dirname(pkg.manifest_path))]);
  validateIgnoredTests(packageSources.flatMap(([, files]) => files));
  const byPackage = new Map(packageSources.map(([pkg, files]) => [pkg.id, databaseTests(files)]));
  const inventory = classifyTests(list, byPackage);
  const defaultInventory = command.database
    ? classifyTests(cargoJSON(["nextest", "list", ...defaultArgs, "--message-format", "json"]), byPackage)
    : inventory;
  const report = path.join(metadata.workspace_root, "target/nextest/ci");
  mkdirSync(report, { recursive: true });
  for (const name of ["junit.xml", "junit-featured.xml", "junit-default.xml"]) rmSync(path.join(report, name), { force: true });
  let expected, runs, label, artifact = inventory;
  if (command.database) {
    const featured = inventory.database;
    const defaults = defaultInventory.database;
    const featuredKeys = new Set(featured.map(identity)), defaultKeys = new Set(defaults.map(identity));
    const missingInBoth = inventory.featureGatedDatabase.filter((id) => new Set(defaultInventory.featureGatedDatabase.map(identity)).has(identity(id)));
    assert.deepEqual(missingInBoth, [], "database declarations are absent from both feature variants");
    const enabled = featured.filter((id) => !defaultKeys.has(identity(id)));
    const defaultOnly = defaults.filter((id) => !featuredKeys.has(identity(id)));
    const tests = [...featured, ...defaultOnly];
    const timings = command.timings && existsSync(command.timings) ? JSON.parse(readFileSync(command.timings, "utf8")) : {};
    const plan = planDatabaseTests(tests, timings, command.total);
    writeFileSync(path.join(report, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
    const shard = plan.shards[command.shard - 1];
    expected = shard.tests;
    const selected = new Set(expected.map(identity));
    runs = [
      { name: "featured", args: featuredArgs, tests: featured.filter((id) => selected.has(identity(id))) },
      { name: "default", args: defaultArgs, tests: defaultOnly.filter((id) => selected.has(identity(id))) },
    ].filter((run) => run.tests.length);
    label = "database";
    artifact = { ...inventory, databaseFeaturesEnabled: enabled, defaultOnlyDatabase: defaultOnly };
    summary(`Rust database tests discovered: ${tests.length} (${enabled.length} enabled by database features, ${defaultOnly.length} requiring the default feature variant); shard ${command.shard}/${command.total} selected ${expected.length} by measured duration (${shard.seconds.toFixed(1)}s estimate).`, env);
    summary(`Source-ignored database quarantine: ${inventory.ignoredDatabase.length} exact owned identities; ${inventory.ignored.length - inventory.ignoredDatabase.length} other source-ignored tests carry owner, reason and expiry.`, env);
  } else {
    const deferred = inventory.database.length + inventory.ignored.length + inventory.featureGatedDatabase.length;
    summary(`Rust tests discovered: ${inventory.selected.length} non-database; ${deferred} deferred (${inventory.database.length} listed database tests, ${inventory.ignored.length} explicitly ignored, ${inventory.featureGatedDatabase.length} feature-gated database source declarations, including test-postgres).`, env);
    for (const [binary, name] of inventory.ignored) summary(`- Ignored by source attribute: \`${binary} / ${name}\``, env);
    expected = inventory.selected;
    runs = [{ name: "non-database", args: defaultArgs, tests: expected, filter: inventory.filter }];
    label = "non-database";
  }
  writeFileSync(path.join(report, "inventory.json"), JSON.stringify(artifact, null, 2) + "\n");
  const results = [];
  for (const run of runs) {
    rmSync(path.join(report, "junit.xml"), { force: true });
    const result = spawnSync("cargo", ["nextest", "run", ...run.args, "--no-fail-fast", "--retries", "0", "--run-ignored", "default", "-E", run.filter ?? exactFilter(run.tests)], { ...options, stdio: "inherit" });
    assert.ifError(result.error);
    const xml = readFileSync(path.join(report, "junit.xml"), "utf8");
    if (command.database) renameSync(path.join(report, "junit.xml"), path.join(report, `junit-${run.name}.xml`));
    const counts = attributes(xml.match(/<testsuites\s[^>]*>/)?.[0] ?? "");
    summary(`JUnit ${run.name}: ${counts.tests ?? "missing"} executed, ${counts.failures ?? "missing"} failures, ${counts.errors ?? "missing"} errors.`, env);
    results.push({ result, tests: run.tests, xml });
  }
  const executed = results.reduce((count, run) => count + verifyJUnit(run.xml, run.tests), 0);
  for (const { result } of results) assert.equal(result.status, 0, `cargo nextest failed (${result.status ?? result.signal})`);
  summary(`JUnit verified: ${executed}/${expected.length} ${label} tests passed in ${((performance.now() - started) / 1000).toFixed(1)}s including discovery and build; no selected tests skipped.`, env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
