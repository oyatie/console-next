// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import yaml from "js-yaml";
import * as backendTests from "./backend-tests.mjs";

const { classifyTests, databaseTests, verifyJUnit } = backendTests;
const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const suite = (names) => ({ "binary-id": "example::mixed", "package-id": "example", "package-name": "example", status: "listed", testcases: Object.fromEntries(names.map((name) => [name, { ignored: false }])) });
const listing = (...suites) => ({ "rust-suites": Object.fromEntries(suites.map((s) => [s["binary-id"], s])) });

test("source attributes distinguish database tests from ordinary tests and literal decoys", () => {
  const source = `// #[sqlx::test] async fn comment() {}
    const DECOY: &str = r#"#[sqlx::test] async fn literal() {}"#;
    #[sqlx::test(migrator = "MIGRATOR")]
    #[allow(clippy::unwrap_used)]
    async fn database(pool: PgPool) {}
    #[tokio::test] async fn ordinary() {}
    #[test] fn sync_test() {}`;
  assert.deepEqual([...databaseTests([source])], ["database"]);
  assert.throws(() => databaseTests([source, "#[test] fn database() {}"]), /ambiguous/);
});

test("SQLx attributes inside test macros classify their generated cases", () => {
  const source = `macro_rules! db_case { ($name:ident, $value:expr) => {
    #[sqlx::test(migrator = "MIGRATOR")] async fn $name(pool: PgPool) { check(pool, $value).await; }
  }; }
  db_case!(first, true); db_case! { second, false }
  #[test] fn ordinary() {}`;
  assert.deepEqual([...databaseTests([source])], ["first", "second"]);
  assert.throws(() => databaseTests([source.replace("($name:ident, $value:expr)", "($value:expr, $name:ident)")]), /unsupported test macro/);
});

test("custom-role PostgreSQL cases use the same database marker as pool-injected cases", () => {
  for (const binary of ["apalis_adapter", "apalis_schema_contract", "apalis_runtime_release"]) {
    const source = readFileSync(new URL(`../backend/crates/platform/jobs/tests/${binary}.rs`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /#\[tokio::test\]/, `${binary}: database cases must carry the SQLx attribute`);
    assert.ok(databaseTests([source]).size);
  }
});

test("mixed binaries retain ordinary tests and exclude only sqlx attributes", () => {
  const s = suite(["nested::database", "nested::ordinary"]);
  const result = classifyTests(listing(s), new Map([["example", new Set(["database"])]]));
  assert.deepEqual(result.selected, [["example::mixed", "nested::ordinary"]]);
  assert.deepEqual(result.database, [["example::mixed", "nested::database"]]);
  assert.match(result.filter, /binary_id\(=example::mixed\).*test\(=nested::database\)/);
  assert.doesNotMatch(result.filter, /ordinary/);
});

test("exact filters escape punctuation in binary and test names", () => {
  const s = { ...suite(["db),\\name", "ordinary"]), "binary-id": "binary),\\name" };
  const result = classifyTests(listing(s), new Map([["example", new Set(["db),\\name"])]]));
  assert.equal(result.filter, "not ((binary_id(=binary\\)\\,\\\\name) & (test(=db\\)\\,\\\\name))))");
  const huge = { ...s, "binary-id": "x".repeat(128 * 1024) };
  assert.throws(() => classifyTests(listing(huge), new Map([["example", new Set(["db),\\name"])]])), /single-argument limit/);
});

test("database declarations behind disabled features remain visible as deferred", () => {
  const names = databaseTests([`#[sqlx::test] async fn database() {}
    #[cfg(feature = "test-postgres")] #[sqlx::test] async fn feature_database() {}`]);
  const result = classifyTests(listing(suite(["database", "ordinary"])), new Map([["example", names]]));
  assert.deepEqual(result.featureGatedDatabase, [["example", "feature_database"]]);
  assert.equal(result.database.length, 1);
});

test("identical names in other packages stay selected and all-database binaries are compact", () => {
  const first = suite(["database"]);
  const second = { ...suite(["database"]), "binary-id": "other", "package-id": "other" };
  const result = classifyTests(listing(first, second), new Map([["example", new Set(["database"])], ["other", new Set()]]));
  assert.deepEqual(result.selected, [["other", "database"]]);
  assert.equal(result.filter, "not (binary_id(=example::mixed))");
});

test("ignored cases are explicitly accounted for; missing inventories fail closed", () => {
  const s = suite(["ordinary", "known_ignored", "ignored_database"]);
  s.testcases.known_ignored.ignored = true;
  s.testcases.ignored_database.ignored = true;
  const result = classifyTests(listing(s), new Map([["example", new Set(["ignored_database"])]]));
  assert.deepEqual(result.ignored, [["example::mixed", "known_ignored"], ["example::mixed", "ignored_database"]]);
  assert.deepEqual(result.ignoredDatabase, [["example::mixed", "ignored_database"]]);
  assert.equal(result.selected.length, 1);
  assert.deepEqual(classifyTests(listing(s), new Map([["example", new Set(["known_ignored", "ignored_database"])]] )).ignored, result.ignored);
  assert.throws(() => classifyTests(listing(s), new Map()), /missing/);
  assert.throws(() => classifyTests(listing({ ...s, status: "skipped" }), new Map([["example", new Set()]])), /listed/);
  assert.throws(() => classifyTests(listing(), new Map()), /zero/);
});

test("default database builds select each planned Cargo target once across the workspace", () => {
  const tests = [
    ["one::shared", "first"], ["two::shared", "second"], ["one::bin/shared", "third"],
    ["one", "fourth"], ["two", "fifth"], ["one::shared", "sixth"],
  ];
  assert.deepEqual(backendTests.defaultDatabaseTargets(tests), ["--test", "shared", "--bin", "shared", "--lib"]);
});

test("database shards use measured durations and cover each selected identity once", () => {
  const ids = Array.from({ length: 8 }, (_, i) => ["example::db", `case_${i}`]);
  const timings = { tests: Object.fromEntries(ids.map((id, i) => [JSON.stringify(id), i + 1])) };
  const plan = backendTests.planDatabaseTests(ids, timings, 4);
  assert.equal(plan.shards.length, 4);
  assert.deepEqual(plan.shards.flatMap((s) => s.tests).sort(), ids.sort());
  assert.ok(Math.max(...plan.shards.map((s) => s.seconds)) - Math.min(...plan.shards.map((s) => s.seconds)) <= 1);
  for (const invalid of [0, 5, 1.5]) assert.throws(() => backendTests.planDatabaseTests(ids, timings, invalid));
  assert.throws(() => backendTests.planDatabaseTests([ids[0], ids[0]], timings, 1), /duplicate/);
});

test("ignored tests require an unexpired owner, reason and expiry", () => {
  const valid = '#[ignore = "owner=import; reason=open regression; expires=2026-12-03"]\n#[test] fn ignored() {}';
  assert.equal(backendTests.validateIgnoredTests([valid], "2026-11-03"), 1);
  assert.equal(backendTests.validateIgnoredTests(['#[test]\n// ignore-policy: owner=db; reason=feature gate; expires=2026-12-03\n#[cfg_attr(not(feature = "test-postgres"), ignore)]\nfn gated() {}'], "2026-11-03"), 1);
  for (const source of [
    "#[ignore]\n#[test] fn bare() {}",
    '#[ignore = "open regression"]\n#[test] fn unowned() {}',
    valid.replace("2026-12-03", "2026-11-02"),
    valid.replace("2026-12-03", "2026-02-30"),
  ]) assert.throws(() => backendTests.validateIgnoredTests([source], "2026-11-03"), /ignore policy/);
});

test("quarantine expiry warns during the seven-day window, including the deadline", () => {
  const source = '#[ignore = "owner=import; reason=regression; expires=2026-12-03"]\n#[test] fn quarantined() {}';
  for (const [today, expected] of [["2026-11-25", 0], ["2026-11-26", 1], ["2026-12-03", 1]]) {
    const warnings = [];
    assert.equal(backendTests.validateIgnoredTests([source], today, warning => warnings.push(warning)), 1);
    assert.equal(warnings.length, expected, today);
    if (expected) assert.match(warnings[0], /quarantined.*owner=import.*2026-12-03.*unignore.*review/i);
  }
  assert.throws(() => backendTests.validateIgnoredTests([source], "2026-12-04"), /expired ignore policy/);
});

test("manual generators carry ownership without a quarantine deadline", () => {
  const generator = '#[ignore = "owner=privacy; reason=manual baseline generator; kind=generator"]\n#[sqlx::test] async fn generate() {}';
  assert.equal(backendTests.validateIgnoredTests([generator], "2099-01-01"), 1);
  for (const invalid of [generator.replace("owner=privacy", "owner="), generator.replace("owner=privacy", "owner= "), generator.replace("reason=manual baseline generator", "reason="), generator.replace("reason=manual baseline generator", "reason= "), generator.replace("kind=generator", "kind=test")]) {
    assert.throws(() => backendTests.validateIgnoredTests([invalid]), /ignore policy/);
  }
});

test("every repository ignore has live ownership metadata and staggered review dates", () => {
  const readRust = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? readRust(file) : entry.name.endsWith(".rs") ? [readFileSync(file, "utf8")] : [];
  });
  const sources = readRust(fileURLToPath(new URL("../backend", import.meta.url)));
  assert.ok(backendTests.validateIgnoredTests(sources) > 0);
  const expiries = sources.flatMap(source => [...source.matchAll(/#\[ignore = "[^"\n]*expires=(\d{4}-\d{2}-\d{2})"\]/g)].map(match => match[1]));
  assert.equal(new Set(expiries).size, expiries.length, "quarantine reviews must be staggered");
});

const junit = (cases, extra = "", failures = 0) => `<?xml version="1.0"?><testsuites tests="${cases.length}" failures="${failures}" errors="0"><testsuite>${cases.map(([binary, name]) => `<testcase classname="${binary}" name="${name}">${extra}</testcase>`).join("")}</testsuite></testsuites>`;
test("JUnit proves exact execution, including XML entities, rather than just a log count", () => {
  assert.equal(verifyJUnit(junit([["binary", "a&amp;b"]]), [["binary", "a&b"]]), 1);
  const expected = [["binary", "one"], ["binary", "two"]];
  assert.equal(verifyJUnit(junit(expected), expected), 2);
  assert.throws(() => verifyJUnit(junit(expected).replace('errors="0"', 'errors="1"'), expected), /test errors/);
  for (const xml of ["", junit(expected.slice(0, 1)), junit([expected[0], expected[0]]), junit([["wrong", "one"], expected[1]]), junit(expected, "<skipped/>"), junit(expected, "<failure/>", 1), junit(expected).replace('tests="2"', 'tests="3"')]) {
    assert.throws(() => verifyJUnit(xml, expected));
  }
});

test("runner propagates failures, refuses stale/missing JUnit and runs without database credentials", () => {
  const root = mkdtempSync(path.join(tmpdir(), "backend-tests-"));
  try {
    mkdirSync(path.join(root, "bin"));
    const sourceFile = path.join(root, "lib.rs");
    writeFileSync(sourceFile, '#[test] fn ordinary() {}\n#[sqlx::test] async fn database(pool: PgPool) {}\n#[sqlx::test]\n#[ignore = "owner=db; reason=fixture; expires=2099-01-01"]\nasync fn ignored_database(pool: PgPool) {}\n#[cfg(feature = "test-postgres")] #[sqlx::test] async fn feature_database() {}\n#[cfg(not(feature = "test-postgres"))] #[sqlx::test] async fn default_database() {}\n#[cfg(feature = "test-postgres")] #[test] fn feature_ordinary() {}');
    const s = suite(["ordinary", "database", "default_database", "ignored_database", "tooling"]);
    s.testcases.ignored_database.ignored = true;
    s.testcases.tooling.ignored = true;
    const db = suite(["ordinary", "database", "ignored_database", "feature_database", "feature_ordinary", "tooling"]);
    db.testcases.ignored_database.ignored = true;
    db.testcases.tooling.ignored = true;
    writeFileSync(path.join(root, "metadata.json"), JSON.stringify({ workspace_root: root, target_directory: path.join(root, "custom-build-cache"), workspace_members: ["example"], packages: [{ id: "example", manifest_path: path.join(root, "Cargo.toml"), targets: [{ name: "first", kind: ["test"] }, { name: "second", kind: ["test"] }, { name: "openapi_drift", kind: ["test"], "required-features": ["full"] }] }] }));
    writeFileSync(path.join(root, "list.json"), JSON.stringify(listing(s)));
    writeFileSync(path.join(root, "list-db.json"), JSON.stringify(listing(db)));
    const cargo = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2);
if (Boolean(process.env.DATABASE_URL || process.env.PGHOST) !== (process.env.EXPECT_DATABASE === '1')) process.exit(91);
if (process.env.EXPECT_DATABASE === '1' && args[0] === 'nextest') {
  const defaultRun = args[1] === 'run' && !args.includes('--features');
  const targetFlags = ['--test', '--bin', '--bins', '--lib'];
  if (!args.includes('--workspace') || args.includes('-p') || (!defaultRun && targetFlags.some(flag => args.includes(flag)))) process.exit(95);
}
if (args[0] === 'metadata') {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json')));
  metadata.resolve = { nodes: [{ id: 'example', features: args[args.indexOf('--features') + 1] === 'console-app/full' ? ['full'] : [] }] };
  process.stdout.write(JSON.stringify(metadata));
}
else if (args[1] === 'list') {
  fs.writeFileSync(path.join(root, 'list-args.json'), JSON.stringify(args));
  process.stdout.write(fs.readFileSync(path.join(root, process.env.EXPECT_DATABASE === '1' && args.includes('--features') ? 'list-db.json' : 'list.json')));
  if (process.env.MODE === 'spawn-error') fs.unlinkSync(__filename);
}
else {
  fs.writeFileSync(path.join(root, 'args.json'), JSON.stringify(args));
  const callsFile = path.join(root, 'calls.json');
  const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile)) : [];
  calls.push(args);
  fs.writeFileSync(callsFile, JSON.stringify(calls));
  const result = process.env.EXPECT_DATABASE === '1' && args.includes('--features') ? 'result-db.xml' : 'result.xml';
  if (process.env.MODE !== 'missing') fs.copyFileSync(path.join(root, result), path.join(root, 'target/nextest/ci/junit.xml'));
  process.exit(process.env.MODE === 'exit' ? 100 : 0);
}
`;
    for (const mode of ["pass", "sharded", "sharded-first", "failure", "exit", "missing", "skipped", "spawn-error"]) {
      writeFileSync(path.join(root, "bin/cargo"), cargo, { mode: 0o755 });
      writeFileSync(path.join(root, "result.xml"), junit([["example::mixed", "ordinary"]], mode === "skipped" ? "<skipped/>" : "", mode === "failure" ? 1 : 0));
      writeFileSync(path.join(root, "result-db.xml"), junit([["example::mixed", "database"], ["example::mixed", "feature_database"]]));
      const result = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], { encoding: "utf8", env: { ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: mode, NEXTEST_SHARD: mode === "sharded" ? "2" : mode === "sharded-first" ? "1" : undefined, NEXTEST_SHARDS: mode.startsWith("sharded") ? "2" : undefined, DATABASE_URL: "postgres://unused.invalid/db", PGHOST: "unused.invalid", GITHUB_STEP_SUMMARY: path.join(root, "summary.md") } });
      assert.equal(result.status, ["pass", "sharded-first", "sharded"].includes(mode) ? 0 : 1, result.stdout + result.stderr);
      if (mode === "sharded") {
        const args = JSON.parse(readFileSync(path.join(root, "args.json"), "utf8"));
        assert.ok(args.includes("--workspace"));
        assert.deepEqual(args.slice(args.indexOf("--test"), args.indexOf("--test") + 2), ["--test", "openapi_drift"], "full-feature drift binary must be in the shard plan");
        assert.ok(!args.includes("--lib") && !args.includes("--bins"));
      }
      if (mode === "sharded-first") {
        const args = JSON.parse(readFileSync(path.join(root, "args.json"), "utf8"));
        assert.deepEqual(args.filter((_, i) => args[i - 1] === "--test"), ["first", "second"]);
        assert.ok(args.includes("--lib") && args.includes("--bins"));
      }
      if (mode === "spawn-error") assert.match(result.stderr, /spawnSync cargo ENOENT/);
      assert.equal(JSON.parse(readFileSync(path.join(root, "target/nextest/ci/inventory.json"), "utf8")).selected.length, 1);
    }
    const args = JSON.parse(readFileSync(path.join(root, "args.json"), "utf8"));
    const listArgs = JSON.parse(readFileSync(path.join(root, "list-args.json"), "utf8"));
    for (const command of [listArgs, args]) {
      assert.equal(command[command.indexOf("--features") + 1], "console-app/full", "discovery and execution must include full-feature OpenAPI drift tests");
    }
    for (const flag of ["--workspace", "--locked", "--no-fail-fast", "--ignore-default-filter"]) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf("--retries") + 1], "0");
    assert.equal(args[args.indexOf("--run-ignored") + 1], "default");
    assert.ok(readFileSync(path.join(root, "summary.md"), "utf8").includes("1/1 non-database tests passed"));
    assert.match(readFileSync(path.join(root, "summary.md"), "utf8"), /5 deferred \(2 listed database tests, 2 explicitly ignored, 1 feature-gated/);
    assert.match(readFileSync(path.join(root, "summary.md"), "utf8"), /Ignored by source attribute: `example::mixed \/ tooling`/);

    writeFileSync(path.join(root, "bin/cargo"), cargo, { mode: 0o755 });
    writeFileSync(path.join(root, "result.xml"), junit([["example::mixed", "default_database"]]));
    writeFileSync(path.join(root, "result-db.xml"), junit(["database", "feature_database", "feature_ordinary"].map(name => ["example::mixed", name])));
    const database = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname, "--db", "--shard", "1/1"], { encoding: "utf8", env: {
      ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: "pass", EXPECT_DATABASE: "1", NEXTEST_SHARD: "2", NEXTEST_SHARDS: "2",
      DATABASE_URL: "postgres://postgres@127.0.0.1/postgres", PGHOST: "127.0.0.1", GITHUB_STEP_SUMMARY: path.join(root, "db-summary.md"),
    } });
    assert.equal(database.status, 0, database.stdout + database.stderr);
    const dbCalls = JSON.parse(readFileSync(path.join(root, "calls.json"), "utf8")).slice(-2);
    assert.equal(dbCalls.length, 2);
    const dbArgs = dbCalls[0], defaultArgs = dbCalls[1];
    assert.deepEqual(defaultArgs.slice(2, 5), ["--workspace", "--test", "mixed"]);
    assert.ok(!defaultArgs.includes("--features"));
    assert.match(defaultArgs.at(-1), /test\(=default_database\)/);
    assert.equal(dbArgs[dbArgs.indexOf("--features") + 1], "test-postgres,console-app/full,console-app/e2e-test-support,console-app/dev-auth");
    assert.equal(dbArgs[dbArgs.indexOf("--run-ignored") + 1], "default");
    for (const name of ["database", "feature_database", "feature_ordinary"]) assert.ok(dbArgs.at(-1).includes(name));
    for (const name of ["ordinary", "tooling", "ignored_database"]) assert.ok(!dbArgs.at(-1).includes(`test(=${name})`));
    const dbInventory = JSON.parse(readFileSync(path.join(root, "target/nextest/ci/inventory.json"), "utf8"));
    assert.deepEqual(dbInventory.ignoredDatabase, [["example::mixed", "ignored_database"]]);
    assert.deepEqual(dbInventory.featureOnlyNonDatabase, [["example::mixed", "feature_ordinary"]]);
    assert.deepEqual(dbInventory.databaseFeaturesEnabled, [["example::mixed", "feature_database"]]);
    assert.match(readFileSync(path.join(root, "db-summary.md"), "utf8"), /4\/4 database tests passed/);
    assert.match(readFileSync(path.join(root, "db-summary.md"), "utf8"), /Source-ignored database quarantine: 1 exact owned identities/);

    const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    writeFileSync(sourceFile, readFileSync(sourceFile, "utf8").replace("expires=2099-01-01", `expires=${deadline}`));
    writeFileSync(path.join(root, "result.xml"), junit([["example::mixed", "ordinary"]]));
    const warning = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], { encoding: "utf8", env: {
      ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: "pass", GITHUB_STEP_SUMMARY: path.join(root, "warning-summary.md"),
    } });
    assert.equal(warning.status, 0, warning.stdout + warning.stderr);
    assert.match(warning.stderr, /::warning::ignored_database: owner=db; quarantine expires/);
    assert.match(readFileSync(path.join(root, "warning-summary.md"), "utf8"), /Warning: ignored_database: owner=db; quarantine expires/);
    writeFileSync(sourceFile, readFileSync(sourceFile, "utf8").replace(`expires=${deadline}`, "expires=2099-01-01"));

    writeFileSync(sourceFile, readFileSync(sourceFile, "utf8").replace("expires=2099-01-01", "expires=2000-01-01"));
    const expired = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], { encoding: "utf8", env: {
      ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: "pass",
    } });
    assert.equal(expired.status, 1, expired.stdout + expired.stderr);
    assert.match(expired.stderr, /ignored_database: invalid or expired ignore policy/);
    writeFileSync(sourceFile, readFileSync(sourceFile, "utf8").replace("expires=2000-01-01", "expires=2099-01-01"));

    writeFileSync(sourceFile, readFileSync(sourceFile, "utf8") + '\n#[cfg(feature = "never-enabled")] #[sqlx::test] async fn missing_database() {}\n');
    const missing = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname, "--db"], { encoding: "utf8", env: {
      ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: "pass", EXPECT_DATABASE: "1", DATABASE_URL: "postgres://postgres@127.0.0.1/postgres",
    } });
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /database declarations are absent from both feature variants/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("database result collection proves all shards and preserves measured durations", () => {
  const ids = [["binary", "one"], ["binary", "two"]];
  const plan = backendTests.planDatabaseTests(ids, {}, 2);
  const result = backendTests.collectDatabaseResults(plan, [
    junit([["binary", "one"]]).replace('<testcase classname="binary" name="one">', '<testcase classname="binary" name="one" time="1.2">'),
    junit([["binary", "two"]]).replace('<testcase classname="binary" name="two">', '<testcase classname="binary" name="two" time="2.3">'),
  ]);
  assert.deepEqual(result.counts, { tests: 2, passed: 2, failed: 0 });
  assert.deepEqual(result.timings.tests, { '["binary","one"]': 1.2, '["binary","two"]': 2.3 });
  assert.throws(() => backendTests.collectDatabaseResults(plan, [junit(ids.slice(0, 1))]), /identities/);
  assert.throws(() => backendTests.collectDatabaseResults(plan, [junit(ids).replace('tests="2"', 'tests="3"')]), /count/);
});

const dbWorkflowFile = readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8");
const dbWorkflow = yaml.load(dbWorkflowFile);

test("database runs keep separate queues for pull requests, dev pushes, nightly runs and each dispatched ref", () => {
  const format = (template, ...args) => template.replace(/\{(\d+)\}/g, (_, index) => args[index]);
  for (const [event_name, ref, expected] of [
    ["pull_request", "refs/pull/7/merge", "db-tests-refs/pull/7/merge"],
    ["push", "refs/heads/dev", "db-tests-trunk"],
    ["schedule", "refs/heads/dev", "db-tests-nightly"],
    ["workflow_dispatch", "refs/heads/dev", "db-tests-dispatch-refs/heads/dev"],
    ["workflow_dispatch", "refs/heads/feature", "db-tests-dispatch-refs/heads/feature"],
    ["workflow_dispatch", "refs/tags/dev", "db-tests-dispatch-refs/tags/dev"],
  ]) {
    const github = { event_name, ref, ref_name: ref.split("/").slice(2).join("/") };
    const group = dbWorkflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/gs, (_, expression) =>
      runInNewContext(expression, { github, format }));
    assert.equal(group, expected, `${event_name} on ${ref}`);
  }
});

test("an input-free branch dispatch runs the same three database jobs as automatic runs", () => {
  assert.ok(Object.hasOwn(dbWorkflow.on, "workflow_dispatch"));
  assert.deepEqual(Object.keys(dbWorkflow.on.workflow_dispatch?.inputs ?? {}), []);
  for (const [event_name, ref] of [
    ["workflow_dispatch", "refs/heads/feature"], ["push", "refs/heads/dev"],
    ["schedule", "refs/heads/dev"], ["pull_request", "refs/pull/7/merge"],
  ]) {
    const github = { event_name, ref, ref_name: ref.split("/").slice(2).join("/") };
    for (const id of ["db-test-timing-source", "db-tests", "db-test-timings"]) {
      const job = dbWorkflow.jobs[id];
      const needs = Object.fromEntries([job.needs ?? []].flat().map(name => [name, { result: "success" }]));
      const condition = (job.if ?? "success()").replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/needs\.([\w-]+)/g, 'needs["$1"]');
      assert.ok(runInNewContext(condition, {
        github, needs, success: () => true, always: () => true, cancelled: () => false, failure: () => false,
      }), `${event_name}: ${id}`);
    }
  }
});

test("the database workflow is tiered, pinned and limited to four duration shards", () => {
  assert.deepEqual(Object.keys(dbWorkflow.on).sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);
  assert.doesNotMatch(dbWorkflowFile, /^\s*merge_group:/m);
  assert.match(dbWorkflowFile, /merge_group.*database.*proof/);
  assert.doesNotMatch(dbWorkflowFile, /60-minute queue/);
  assert.doesNotMatch(dbWorkflowFile, /CI-[A-Z]+/);
  assert.match(dbWorkflowFile, /push:\s*\n\s*branches: \[dev\]/);
  assert.match(dbWorkflowFile, /schedule:\s*\n\s*- cron:/);
  assert.equal(dbWorkflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(dbWorkflow.on.pull_request.paths, [
    ".github/workflows/db-tests.yml",
    "scripts/backend-tests.mjs",
    "deploy/dev/postgres-init.sh",
    ".config/nextest.toml",
  ]);
  const job = dbWorkflow.jobs["db-tests"];
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(job.strategy["max-parallel"], 4);
  const compose = readFileSync(new URL("../deploy/dev/compose.e2e.yml", import.meta.url), "utf8");
  assert.equal(job.services.postgres.image, compose.match(/image: (postgres:[^\n]+)/)[1]);
  assert.equal(job.services.postgres.env.POSTGRES_USER, "console_buck_admin");
  assert.match(job.services.postgres.env.POSTGRES_DB, /_contract$/);
  const url = new URL(job.env.DATABASE_URL);
  assert.equal(url.username, job.services.postgres.env.POSTGRES_USER);
  assert.equal(url.pathname, `/${job.services.postgres.env.POSTGRES_DB}`);
  assert.equal(url.searchParams.get("options[console.sqlx_test_bootstrap]"), "buck-sqlx-superuser-v1");
  const init = job.steps.find(step => step.name === "Provision PostgreSQL test roles");
  assert.ok(init && !init.if);
  assert.match(init.run, /deploy\/dev\/postgres-init\.sh/);
  assert.ok(job.steps.indexOf(init) < job.steps.findIndex(step => step.name === "Run duration shard"));
  const run = job.steps.find((step) => step.run?.includes("scripts/backend-tests.mjs --db"));
  assert.match(run.run, /--shard.*matrix\.shard.*\/4/);
  assert.match(run.run, /--timings/);
  assert.equal(dbWorkflow.jobs["db-test-timings"].needs, "db-tests");
  assert.equal(dbWorkflow.jobs["db-test-timings"].if, "${{ always() && needs.db-tests.result != 'cancelled' }}");
  const steps = dbWorkflow.jobs["db-test-timings"].steps;
  const timings = steps.find(step => step.with?.name === "db-test-timings");
  assert.equal(timings.if, `\${{ !cancelled() && hashFiles('${timings.with.path}') != '' }}`);
  assert.deepEqual(dbWorkflow.permissions, {});
  const results = job.steps.find(step => step.with?.name === "db-test-results-${{ matrix.shard }}");
  assert.equal(results.if, "${{ !cancelled() }}");
  assert.equal(results.with["if-no-files-found"], "error");
  for (const workflowJob of Object.values(dbWorkflow.jobs)) for (const step of workflowJob.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    assert.ok(!step["continue-on-error"]);
  }
});

test("database results upload without archiving or restoring unused Rust caches", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs["db-tests"].steps;
  assert.ok(!steps.some(step => step.uses?.startsWith("actions/cache")));
  assert.ok(!steps.some(step => step.id === "cache-budget"));
});

test("database failures do not call the disabled Issues service", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  assert.ok(!workflow.jobs["alert-nightly"]);
  assert.ok(Object.values(workflow.jobs).every(job => !job.permissions?.issues));
});

test("database builds reclaim hosted disk before compilation and report disk even on failure", () => {
  const job = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8")).jobs["db-tests"];
  const cleanup = job.steps.find(step => step.name === "Reclaim runner disk");
  assert.ok(cleanup && !cleanup.if, "every database shard must reclaim disk");
  const runIndex = job.steps.findIndex(step => step.name === "Run duration shard");
  assert.ok(job.steps.indexOf(cleanup) < runIndex);
  assert.equal(job.env.CARGO_PROFILE_DEV_DEBUG, "0");
  assert.equal(job.env.CARGO_PROFILE_TEST_DEBUG, "0");
  const report = job.steps.find(step => step.name === "Report disk after database tests");
  assert.ok(report && job.steps.indexOf(report) > runIndex);
  assert.equal(report.if, "${{ !cancelled() }}");
  const root = mkdtempSync(path.join(tmpdir(), "database-disk-"));
  try {
    for (const [name, script] of Object.entries({
      df: `require('node:fs').appendFileSync(process.env.CALLS, 'df\\n'); console.log('available disk');`,
      sudo: `require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(Number(process.env.CLEANUP_STATUS));`,
    })) writeFileSync(path.join(root, name), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    for (const status of [0, 73]) {
      const calls = path.join(root, `calls-${status}`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", cleanup.run], { encoding: "utf8", env: {
        ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS: calls, CLEANUP_STATUS: String(status), GITHUB_WORKSPACE: root,
      } });
      assert.equal(result.status, status, result.stdout + result.stderr);
      const events = readFileSync(calls, "utf8").trim().split("\n");
      assert.equal(events[0], "df", "measure disk before deleting anything");
      assert.deepEqual(JSON.parse(events[1]), ["rm", "-rf", "--", "/usr/share/dotnet", "/usr/share/swift", "/opt/hostedtoolcache/CodeQL"]);
      assert.deepEqual(events.slice(2), status ? [] : ["df"]);
      assert.equal(result.stdout.match(/available disk/g)?.length, status ? 1 : 2);
    }
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", report.run], { encoding: "utf8", env: {
      ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS: path.join(root, "report-calls"), GITHUB_WORKSPACE: root,
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /available disk/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("database wall-clock budgets reserve every test slot without excluding cases", () => {
  const config = readFileSync(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  const overrides = [...config.matchAll(/\[\[profile\.ci\.overrides\]\]\s*\nfilter = '([^']+)'\s*\nthreads-required = "([^"]+)"/g)];
  const budget = overrides.find(([, filter]) => filter === "test(/budget/)");
  assert.ok(budget, "database budget tests need exclusive execution");
  assert.equal(budget[2], "num-test-threads");
});

test("cluster-wide role mutators and console_app migrations share exclusive execution", () => {
  const config = readFileSync(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  const group = config.split("[[profile.default.overrides]]")[1].split("[profile.ci]")[0];
  assert.match(group, /test-group = 'cluster-global'/);
  assert.match(group, /threads-required = "num-test-threads"/);
  for (const name of [
    "binary(owner_only_acl_postgres18)", "test(=corrects_stored_phones_and_preserves_revision_history)",
    "test(=baseline_upgrade_preserves_keys_and_denies_unknown_codec)",
    "leave_migration_expand_contract", "key_revision_migration_upgrade",
    "attendance_console_migration_contract", "apalis_adapter", "apalis_schema_contract",
    "apalis_runtime_release", "group_of_one_expand_contract",
    "migrated_canonical_tables_have_only_expected_writers",
    "definitions_migrated_by_console_app_are_read_only_for_runtime",
    "placement_migrations_run_as_console_app", "console_app_may_set_its_own_lock_timeout_default",
    "status_worker_age_is_queue_scoped_read_only_and_missing_is_unknown",
    "status_public_evidence_answers_aggregate_age_only_beside_tenant_data",
    "serving_pool_rejects_overrides_and_restores_role_defaults_after_release",
  ]) assert.ok(group.includes(name), `${name} must share the exclusive role group`);
  assert.match(config, /\[test-groups\.cluster-global\]\s+max-threads = 1/);
});

test("PostgreSQL provisioning exports matching random fixture credentials and refuses initialization failures", () => {
  const job = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8")).jobs["db-tests"];
  const init = job.steps.find(step => step.name === "Provision PostgreSQL test roles");
  assert.ok(init);
  const root = mkdtempSync(path.join(tmpdir(), "postgres-provision-"));
  try {
    writeFileSync(path.join(root, "docker"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8'), env: process.env }) + '\\n');
process.exit(Number(process.env.DOCKER_STATUS ?? 0));
`, { mode: 0o755 });
    const passwords = [];
    for (const status of [0, 0, 1]) {
      const output = path.join(root, `env-${passwords.length}-${status}`), calls = path.join(root, `calls-${passwords.length}-${status}`);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", init.run], { encoding: "utf8", env: {
        ...process.env, PATH: `${root}:${process.env.PATH}`, DATABASE_URL: job.env.DATABASE_URL,
        POSTGRES_CONTAINER: "fixture-postgres", GITHUB_ENV: output, CALLS: calls, DOCKER_STATUS: String(status),
      } });
      const invocations = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (status) {
        assert.notEqual(result.status, 0);
        assert.equal(invocations.length, 1);
        assert.ok(!existsSync(output));
        continue;
      }
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(invocations.length, 2);
      const fixtures = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => {
        const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
      }));
      assert.equal(Object.keys(fixtures).length, 6);
      const admin = new URL(fixtures.DATABASE_URL), owner = new URL(fixtures.CONSOLE_APALIS_OWNER_DATABASE_URL), runtime = new URL(fixtures.CONSOLE_APALIS_RUNTIME_DATABASE_URL);
      assert.equal(fixtures.CONSOLE_APALIS_ADMIN_DATABASE_URL, admin.href);
      assert.equal(admin.search, new URL(job.env.DATABASE_URL).search);
      assert.equal(owner.username, "console_app");
      assert.equal(runtime.username, "console_rt");
      assert.equal(owner.password, invocations[0].env.CONSOLE_APP_POSTGRES_PASSWORD);
      assert.equal(runtime.password, invocations[0].env.CONSOLE_RT_POSTGRES_PASSWORD);
      assert.equal(runtime.password, fixtures.CONSOLE_TEST_RUNTIME_PASSWORD);
      assert.equal(fixtures.CONSOLE_TEST_FORCE_PASSWORD, invocations[0].env.CONSOLE_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD);
      assert.equal(owner.search, ""); assert.equal(runtime.search, "");
      assert.equal(owner.pathname, admin.pathname); assert.equal(runtime.pathname, admin.pathname);
      const keys = [...invocations[0].input.matchAll(/"\$(CONSOLE_\w+_PASSWORD)"/g)].map(match => match[1]);
      assert.equal(keys.length, 5);
      for (const key of ["POSTGRES_PASSWORD", ...keys]) {
        assert.ok(invocations[0].args.includes(key), key);
        assert.match(invocations[0].env[key], /^[a-f0-9]{48}$/);
        assert.ok(result.stdout.includes(`::add-mask::${invocations[0].env[key]}`));
      }
      assert.equal(new Set([admin.password, ...keys.map(key => invocations[0].env[key])]).size, 6);
      assert.equal(admin.password, invocations[0].env.POSTGRES_PASSWORD);
      assert.ok(invocations[1].input.includes(admin.password));
      assert.ok(invocations[1].args.includes("ON_ERROR_STOP=1"));
      passwords.push(admin.password);
    }
    assert.notEqual(passwords[0], passwords[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("timing artifacts come only from this workflow's own dev push and nightly runs, whatever their outcome", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  const job = workflow.jobs["db-test-timing-source"];
  const step = job.steps.find(step => step.id === "timings");
  assert.equal(step.run, "node .github/ci-proof.cjs --any-conclusion db-test-timings db-tests.yml push schedule");
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
  assert.deepEqual(job.permissions, { actions: "read", contents: "read" });
  assert.ok(job.steps.findIndex(s => s.uses?.startsWith("actions/checkout@")) < job.steps.indexOf(step));
});

test("database collection requires exactly the results directory and timings output", () => {
  const script = fileURLToPath(new URL("./backend-tests.mjs", import.meta.url));
  for (const args of [["results"], ["results", "timings.json", "junit.xml"]]) {
    const result = spawnSync(process.execPath, [script, "--collect", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /usage: --collect/);
  }
});

test("database reconciliation refuses a plan with zero tests", () => {
  const root = mkdtempSync(path.join(tmpdir(), "database-results-"));
  try {
    const shard = path.join(root, "db-test-results-1");
    mkdirSync(shard);
    writeFileSync(path.join(shard, "plan.json"), JSON.stringify({ version: 1, tests: [], shards: [] }));
    const output = path.join(root, "timings.json");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./backend-tests.mjs", import.meta.url)), "--collect", root, output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /zero database tests/);
    assert.ok(!existsSync(output));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("database reconciliation uses any available shard plan and refuses incomplete or conflicting evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "database-results-"));
  const ids = [["binary", "one"], ["binary", "two"]];
  const plan = backendTests.planDatabaseTests(ids, {}, 2);
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  const collect = workflow.jobs["db-test-timings"].steps.find(step => step.run?.includes("--collect"));
  const run = () => spawnSync("bash", ["-e", "-o", "pipefail", "-c", collect.run], { cwd: root, encoding: "utf8" });
  try {
    mkdirSync(path.join(root, "scripts"));
    for (const name of ["backend-tests.mjs", "check-executed-tests-cfg.mjs"])
      writeFileSync(path.join(root, "scripts", name), readFileSync(new URL(name, import.meta.url)));
    const results = path.join(root, ".cache/db-test-results");
    for (const shard of [1, 2]) {
      mkdirSync(path.join(results, `db-test-results-${shard}`), { recursive: true });
      writeFileSync(path.join(results, `db-test-results-${shard}/junit-featured.xml`), junit([ids[shard - 1]]));
    }
    const planFile = path.join(results, "db-test-results-2/plan.json");
    writeFileSync(planFile, JSON.stringify(plan));
    let result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /2 run, 2 passed, 0 failed/);
    const output = path.join(root, ".cache/db-test-timings/timings.json");
    assert.equal(Object.keys(JSON.parse(readFileSync(output)).tests).length, 2);
    rmSync(output);
    const firstReport = path.join(results, "db-test-results-1/junit-featured.xml");
    rmSync(firstReport);
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identities differ/);
    assert.ok(!existsSync(output));
    writeFileSync(firstReport, junit([ids[0]], "<failure/>", 1));
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /2 run, 1 passed, 1 failed/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(output)).tests), ids.map(id => JSON.stringify(id)));
    rmSync(output);
    writeFileSync(firstReport, junit([ids[0]]));
    const firstPlan = path.join(results, "db-test-results-1/plan.json");
    writeFileSync(firstPlan, JSON.stringify({ ...plan, tests: [...ids].reverse(), shards: [...plan.shards].reverse() }));
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    rmSync(output);
    writeFileSync(firstPlan, JSON.stringify({ ...plan, tests: [...ids, ["binary", "unplanned"]] }));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shard plans differ/);
    assert.ok(!existsSync(output));
    rmSync(firstPlan);
    rmSync(planFile);
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no database shard plan/);
    assert.ok(!existsSync(output));
    rmSync(firstReport);
    rmSync(path.join(results, "db-test-results-2/junit-featured.xml"));
    writeFileSync(planFile, JSON.stringify(plan));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identities differ/);
    assert.ok(!existsSync(output));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backend tests inherit hardening, pinned tooling, JUnit artifacts and blocking ci-ok wiring", () => {
  const job = workflow.jobs["backend-tests"];
  assert.ok(job, "backend checks and tests must execute in CI");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.env.SQLX_OFFLINE, "true");
  assert.match(job.env.CARGO_NEXTEST_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!job["continue-on-error"]);
  assert.ok(job.steps[0].uses.startsWith("step-security/harden-runner@"));
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    const cacheMaintenance = step.name === "Collect Rust cache changes" || step.with?.name?.startsWith("rust-cache-") === true;
    assert.equal(step["continue-on-error"] ?? false, cacheMaintenance);
  }
  const run = job.steps.find((s) => s.run === "node scripts/backend-tests.mjs");
  assert.ok(run && !run.if);
  assert.equal(run["working-directory"], ".");
  const check = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.check;
  assert.match(check, /node --test[^&]*scripts\/backend-tests\.test\.mjs/);
  const install = job.steps.find((s) => s.name === "Install pinned Rust test runner");
  assert.ok(install.run.includes("releases/download/cargo-nextest-${CARGO_NEXTEST_VERSION}/"));
  assert.match(install.run, /[a-f0-9]{64}.*sha256sum -c -/);
  const artifact = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === "backend-test-results-${{ matrix.shard }}");
  assert.equal(artifact.if, "${{ !cancelled() }}");
  assert.equal(artifact.with["if-no-files-found"], "error");
  assert.ok(workflow.jobs["ci-ok"].needs.includes("backend-tests"));
});

for (const mode of ["pass", "compile-error"]) test(`cold-cache discovery: ${mode} builds targets or exposes Cargo stderr`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "backend-cold-"));
  try {
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "member"));
    writeFileSync(path.join(root, "member/lib.rs"), "#[test] fn ordinary() {}\n");
    const metadata = { workspace_root: root, workspace_members: ["example"], packages: [{
      id: "example", manifest_path: path.join(root, "member/Cargo.toml"), targets: [
        { name: "ordinary", kind: ["test"] }, { name: "optional", kind: ["test"], "required-features": ["full"] },
      ],
    }, { id: "external", manifest_path: path.join(root, "absent/Cargo.toml"), targets: [] }], resolve: { nodes: [{ id: "example", features: [] }] } };
    mkdirSync(path.join(root, "external"));
    writeFileSync(path.join(root, "external/lib.rs"), '#[ignore]\n#[test] fn third_party() {}');
    metadata.packages[1].manifest_path = path.join(root, "external/Cargo.toml");
    writeFileSync(path.join(root, "metadata.json"), JSON.stringify(metadata));
    writeFileSync(path.join(root, "list.json"), JSON.stringify(listing(suite(["ordinary"]))));
    writeFileSync(path.join(root, "result.xml"), junit([["example::mixed", "ordinary"]]));
    writeFileSync(path.join(root, "bin/cargo"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2);
if (args[0] === 'metadata') {
  if (args.includes('--no-deps') && process.env.MODE === 'pass') process.exit(91);
  process.stdout.write(fs.readFileSync(path.join(root, 'metadata.json')));
} else if (args[1] === 'list') {
  if (args.includes('--no-run') || args.includes('--no-build') || args.includes('optional')) process.exit(92);
  if (process.env.MODE === 'compile-error') { process.stderr.write('error: test binary compilation failed\\n'); process.exit(101); }
  fs.writeFileSync(path.join(root, 'built'), 'binary');
  process.stdout.write(fs.readFileSync(path.join(root, 'list.json')));
} else {
  if (!fs.existsSync(path.join(root, 'built'))) process.exit(93);
  fs.copyFileSync(path.join(root, 'result.xml'), path.join(root, 'target/nextest/ci/junit.xml'));
}
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], {
      encoding: "utf8", env: { ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: mode, NEXTEST_SHARD: "1", NEXTEST_SHARDS: "1" },
    });
    assert.equal(result.status, mode === "pass" ? 0 : 1, result.stdout + result.stderr);
    if (mode === "compile-error") {
      assert.match(result.stderr, /error: test binary compilation failed/);
      assert.match(result.stderr, /cargo nextest list failed \(101\)/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo diagnostics reach the job log before discovery exits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "backend-stderr-"));
  try {
    writeFileSync(path.join(root, "cargo"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
process.stderr.write('compiling test binaries\\n');
setInterval(() => { if (fs.existsSync(path.join(process.env.FIXTURE_ROOT, 'ack'))) process.exit(101); }, 10);
setTimeout(() => process.exit(94), 3000);
`, { mode: 0o755 });
    const child = spawn(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], {
      env: { ...process.env, PATH: root, FIXTURE_ROOT: root }, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (stderr.includes("compiling test binaries")) writeFileSync(path.join(root, "ack"), "");
    });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(status, 1, stderr);
    assert.match(stderr, /cargo metadata --locked failed \(101\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneTargetExecutables removes extensionless binaries while keeping library artifacts and directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "prune-deps-"));
  try {
    assert.equal(backendTests.pruneTargetExecutables(undefined), 0);
    assert.equal(backendTests.pruneTargetExecutables(root), 0);
    const depsDir = path.join(root, "debug", "deps");
    mkdirSync(path.join(depsDir, ".fingerprint"), { recursive: true });
    mkdirSync(path.join(depsDir, "build"), { recursive: true });
    mkdirSync(path.join(depsDir, "extensionless_dir"), { recursive: true });
    const keepFiles = ["libfoo-1234.rlib", "libfoo-1234.rmeta", "libfoo-1234.so", "libfoo-1234.dylib", "foo-1234.d", "libfoo.a", "foo.o", ".cargo-lock"];
    for (const file of keepFiles) writeFileSync(path.join(depsDir, file), "keep");
    writeFileSync(path.join(depsDir, ".fingerprint", "marker"), "keep");
    writeFileSync(path.join(depsDir, "foo_test-0123456789abcdef"), "elf-binary");
    writeFileSync(path.join(depsDir, "bar_test-fedcba9876543210"), "elf-binary");
    assert.equal(backendTests.pruneTargetExecutables(root), 2);
    for (const file of keepFiles) assert.ok(existsSync(path.join(depsDir, file)), `expected ${file} preserved`);
    assert.ok(existsSync(path.join(depsDir, ".fingerprint", "marker")));
    assert.ok(existsSync(path.join(depsDir, "build")));
    assert.ok(existsSync(path.join(depsDir, "extensionless_dir")));
    assert.ok(!existsSync(path.join(depsDir, "foo_test-0123456789abcdef")));
    assert.ok(!existsSync(path.join(depsDir, "bar_test-fedcba9876543210")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--db lists default before featured and prunes extensionless executables between builds", () => {
  const root = mkdtempSync(path.join(tmpdir(), "backend-db-prune-"));
  try {
    mkdirSync(path.join(root, "bin"));
    const targetDir = path.join(root, "target");
    const depsDir = path.join(targetDir, "debug", "deps");
    mkdirSync(path.join(depsDir, ".fingerprint"), { recursive: true });
    writeFileSync(path.join(depsDir, "libapp.rlib"), "rlib");
    writeFileSync(path.join(depsDir, "libapp.rmeta"), "rmeta");
    writeFileSync(path.join(depsDir, "app.d"), "dep");
    writeFileSync(path.join(depsDir, ".fingerprint", "pkg"), "fp");

    writeFileSync(
      path.join(root, "lib.rs"),
      '#[test] fn ordinary() {}\n#[sqlx::test] async fn database(pool: PgPool) {}\n#[cfg(not(feature = "test-postgres"))] #[sqlx::test] async fn default_database() {}\n#[cfg(feature = "test-postgres")] #[sqlx::test] async fn feature_database() {}',
    );
    const defaultSuite = suite(["ordinary", "database", "default_database"]);
    const featuredSuite = suite(["ordinary", "database", "feature_database"]);
    writeFileSync(path.join(root, "metadata.json"), JSON.stringify({
      workspace_root: root,
      target_directory: targetDir,
      workspace_members: ["example"],
      packages: [{ id: "example", manifest_path: path.join(root, "Cargo.toml"), targets: [{ name: "db", kind: ["test"] }] }],
    }));
    writeFileSync(path.join(root, "list-default.json"), JSON.stringify(listing(defaultSuite)));
    writeFileSync(path.join(root, "list-featured.json"), JSON.stringify(listing(featuredSuite)));
    writeFileSync(path.join(root, "result-default.xml"), junit([["example::mixed", "default_database"]]));
    writeFileSync(path.join(root, "result-featured.xml"), junit([["example::mixed", "database"], ["example::mixed", "feature_database"]]));

    writeFileSync(path.join(root, "bin", "cargo"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, depsDir = path.join(root, 'target', 'debug', 'deps'), args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(path.join(root, 'events.log'), JSON.stringify(entry) + '\\n');
if (args[0] === 'metadata') {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json')));
  metadata.resolve = { nodes: [{ id: 'example', features: [] }] };
  process.stdout.write(JSON.stringify(metadata));
} else if (args[1] === 'list') {
  const isFeatured = args.includes('--features');
  log({
    step: isFeatured ? 'list:featured' : 'list:default',
    hasDefaultBin: fs.existsSync(path.join(depsDir, 'default_bin-0123456789abcdef')),
    hasRlib: fs.existsSync(path.join(depsDir, 'libapp.rlib')),
    hasRmeta: fs.existsSync(path.join(depsDir, 'libapp.rmeta')),
    hasDep: fs.existsSync(path.join(depsDir, 'app.d')),
    hasFingerprint: fs.existsSync(path.join(depsDir, '.fingerprint', 'pkg')),
  });
  fs.writeFileSync(path.join(depsDir, isFeatured ? 'featured_bin-fedcba9876543210' : 'default_bin-0123456789abcdef'), 'exe');
  process.stdout.write(fs.readFileSync(path.join(root, isFeatured ? 'list-featured.json' : 'list-default.json')));
} else if (args[1] === 'run') {
  const isFeatured = args.includes('--features');
  log({
    step: isFeatured ? 'run:featured' : 'run:default',
    hasFeaturedBin: fs.existsSync(path.join(depsDir, 'featured_bin-fedcba9876543210')),
    hasRlib: fs.existsSync(path.join(depsDir, 'libapp.rlib')),
    hasRmeta: fs.existsSync(path.join(depsDir, 'libapp.rmeta')),
    hasDep: fs.existsSync(path.join(depsDir, 'app.d')),
    hasFingerprint: fs.existsSync(path.join(depsDir, '.fingerprint', 'pkg')),
  });
  if (!isFeatured) fs.writeFileSync(path.join(depsDir, 'default_rerun-1111222233334444'), 'exe');
  fs.copyFileSync(path.join(root, isFeatured ? 'result-featured.xml' : 'result-default.xml'), path.join(root, 'target/nextest/ci/junit.xml'));
}
`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname, "--db", "--shard", "1/1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, DATABASE_URL: "postgres://postgres@127.0.0.1/postgres" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const events = readFileSync(path.join(root, "events.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.step), ["list:default", "list:featured", "run:featured", "run:default"]);
    assert.equal(events[1].hasDefaultBin, false, "default executables must be pruned before featured listing");
    assert.equal(events[2].hasFeaturedBin, true, "featured executables must remain for featured run");
    assert.equal(events[3].hasFeaturedBin, false, "featured executables must be pruned before default run");
    for (const event of events) {
      assert.ok(event.hasRlib && event.hasRmeta && event.hasDep && event.hasFingerprint);
    }
    assert.ok(!existsSync(path.join(depsDir, "default_rerun-1111222233334444")), "executables must be pruned after runs finish");
    assert.ok(existsSync(path.join(depsDir, "libapp.rlib")));
    assert.ok(existsSync(path.join(depsDir, "libapp.rmeta")));
    assert.ok(existsSync(path.join(depsDir, "app.d")));
    assert.ok(existsSync(path.join(depsDir, ".fingerprint", "pkg")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
