// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.ok(expiries.length > 0);
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
    writeFileSync(path.join(root, "metadata.json"), JSON.stringify({ workspace_root: root, target_directory: path.join(root, "custom-build-cache"), workspace_members: ["example"], packages: [{ id: "example", manifest_path: path.join(root, "Cargo.toml"), targets: [{ name: "first", kind: ["test"] }, { name: "second", kind: ["test"] }] }] }));
    writeFileSync(path.join(root, "list.json"), JSON.stringify(listing(s)));
    writeFileSync(path.join(root, "list-db.json"), JSON.stringify(listing(db)));
    const cargo = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2);
if (Boolean(process.env.DATABASE_URL || process.env.PGHOST) !== (process.env.EXPECT_DATABASE === '1')) process.exit(91);
if (args[0] === 'metadata') process.stdout.write(fs.readFileSync(path.join(root, 'metadata.json')));
else if (args[1] === 'list') {
  if (process.env.EXPECT_DATABASE === '1' && (!args.includes('--workspace') || ['--test', '--lib', '--bins'].some(flag => args.includes(flag)))) process.exit(95);
  process.stdout.write(fs.readFileSync(path.join(root, args.includes('--features') ? 'list-db.json' : 'list.json')));
  if (process.env.MODE === 'spawn-error') fs.unlinkSync(__filename);
}
else {
  if (process.env.EXPECT_DATABASE === '1' && (!args.includes('--workspace') || ['--test', '--lib', '--bins'].some(flag => args.includes(flag)))) process.exit(95);
  fs.writeFileSync(path.join(root, 'args.json'), JSON.stringify(args));
  const callsFile = path.join(root, 'calls.json');
  const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile)) : [];
  calls.push(args);
  fs.writeFileSync(callsFile, JSON.stringify(calls));
  const result = args.includes('--features') ? 'result-db.xml' : 'result.xml';
  if (process.env.MODE !== 'missing') fs.copyFileSync(path.join(root, result), path.join(root, 'target/nextest/ci/junit.xml'));
  process.exit(process.env.MODE === 'exit' ? 100 : 0);
}
`;
    for (const mode of ["pass", "sharded", "failure", "exit", "missing", "skipped", "spawn-error"]) {
      writeFileSync(path.join(root, "bin/cargo"), cargo, { mode: 0o755 });
      writeFileSync(path.join(root, "result.xml"), junit([["example::mixed", "ordinary"]], mode === "skipped" ? "<skipped/>" : "", mode === "failure" ? 1 : 0));
      writeFileSync(path.join(root, "result-db.xml"), junit([["example::mixed", "database"], ["example::mixed", "feature_database"]]));
      const result = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], { encoding: "utf8", env: { ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: mode, NEXTEST_SHARD: mode === "sharded" ? "2" : undefined, NEXTEST_SHARDS: mode === "sharded" ? "2" : undefined, DATABASE_URL: "postgres://unused.invalid/db", PGHOST: "unused.invalid", GITHUB_STEP_SUMMARY: path.join(root, "summary.md") } });
      assert.equal(result.status, ["pass", "sharded"].includes(mode) ? 0 : 1, result.stdout + result.stderr);
      if (mode === "sharded") {
        const args = JSON.parse(readFileSync(path.join(root, "args.json"), "utf8"));
        assert.ok(args.includes("--workspace"));
        assert.deepEqual(args.slice(args.indexOf("--test"), args.indexOf("--test") + 2), ["--test", "second"]);
        assert.ok(!args.includes("--lib") && !args.includes("--bins"));
      }
      if (mode === "spawn-error") assert.match(result.stderr, /spawnSync cargo ENOENT/);
      assert.equal(JSON.parse(readFileSync(path.join(root, "target/nextest/ci/inventory.json"), "utf8")).selected.length, 1);
    }
    const args = JSON.parse(readFileSync(path.join(root, "args.json"), "utf8"));
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

test("the database workflow is tiered, pinned and limited to four duration shards", () => {
  const file = readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8");
  const dbWorkflow = yaml.load(file);
  assert.deepEqual(Object.keys(dbWorkflow.on).sort(), ["pull_request", "push", "schedule"]);
  assert.doesNotMatch(file, /^\s*merge_group:/m);
  assert.match(file, /merge_group.*queue timeout/);
  assert.doesNotMatch(file, /CI-[A-Z]+/);
  assert.match(file, /push:\s*\n\s*branches: \[dev\]/);
  assert.match(file, /schedule:\s*\n\s*- cron:/);
  assert.equal(dbWorkflow.concurrency.group, "db-tests-${{ github.event_name == 'pull_request' && github.ref || 'trunk' }}");
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
  const restore = job.steps.find((step) => step.uses?.startsWith("actions/cache/restore@"));
  const save = job.steps.find((step) => step.uses?.startsWith("actions/cache/save@"));
  assert.deepEqual(restore.with.path.split("\n"), [
    "~/.cargo/registry",
    "backend/target/*/.fingerprint",
    "backend/target/*/build",
    "backend/target/*/deps",
  ]);
  assert.match(restore.with.key, /hashFiles\('backend\/rust-toolchain\.toml', 'backend\/Cargo\.lock', 'backend\/\*\*\/Cargo\.toml'\)/);
  assert.equal(save.with.path, restore.with.path);
  assert.match(save.if, /!cancelled\(\)/);
  assert.match(save.if, /steps\.rust-cache\.outputs\.cache-hit != 'true'/);
  assert.match(save.if, /github\.event_name == 'push'.*github\.ref == 'refs\/heads\/dev'.*matrix\.shard == 1/);
  const budget = job.steps.find((step) => step.name === "Check Rust cache budget");
  assert.equal(budget.env.RUST_CACHE_MAX_BYTES, "3221225472");
  assert.equal(budget.if, "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/dev' && matrix.shard == 1 && steps.rust-cache.outputs.cache-hit != 'true' }}");
  assert.match(budget.run, /find.*\.cargo\/registry.*find backend\/target.*\.fingerprint.*build.*deps/s);
  assert.match(budget.run, /tar.*zstd.*stat -c %s/s);
  const overBudget = budget.run.match(/if \(\( cache_bytes > RUST_CACHE_MAX_BYTES \)\); then(?<body>[\s\S]*?)\n\s*else/)?.groups?.body;
  assert.ok(overBudget);
  assert.match(overBudget, /::warning::/);
  assert.match(overBudget, /save=false/);
  assert.doesNotMatch(overBudget, /(?:^|\n)\s*(?:exit(?:\s|$)|false\s*$)/m);
  const budgetRoot = mkdtempSync(path.join(tmpdir(), "rust-cache-budget-"));
  try {
    for (const cacheBytes of [99, 100, 101]) {
      const output = path.join(budgetRoot, String(cacheBytes));
      const decision = spawnSync("bash", ["-e", "-c", budget.run.slice(budget.run.indexOf("if (("))], { encoding: "utf8", env: {
        ...process.env, cache_bytes: String(cacheBytes), RUST_CACHE_MAX_BYTES: "100", GITHUB_OUTPUT: output,
      } });
      assert.equal(decision.status, 0, decision.stdout + decision.stderr);
      assert.equal(readFileSync(output, "utf8"), `save=${cacheBytes <= 100}\n`);
      if (cacheBytes > 100) assert.match(decision.stdout, /::warning::/);
    }
  } finally { rmSync(budgetRoot, { recursive: true, force: true }); }
  assert.doesNotMatch(budget.run, /\btest\b.*RUST_CACHE_MAX_BYTES/);
  assert.match(save.if, /steps\.cache-budget\.outputs\.save == 'true'/);
  assert.equal(dbWorkflow.jobs["db-test-timings"].needs, "db-tests");
  assert.equal(dbWorkflow.jobs["db-test-timings"].if, "${{ always() && needs.db-tests.result != 'cancelled' }}");
  assert.deepEqual(dbWorkflow.permissions, {});
  const results = job.steps.find(step => step.with?.name === "db-test-results-${{ matrix.shard }}");
  assert.equal(results.if, "${{ !cancelled() }}");
  assert.equal(results.with["if-no-files-found"], "error");
  const alert = dbWorkflow.jobs["alert-nightly"];
  assert.deepEqual(alert.permissions, { contents: "read", issues: "write" });
  assert.equal(alert.if, "${{ always() && github.event_name == 'schedule' && (needs.db-test-timing-source.result != 'success' || needs.db-tests.result != 'success' || needs.db-test-timings.result != 'success') }}");
  assert.match(alert.steps.map((step) => step.run ?? "").join("\n"), /issues.*comments|comments.*issues/s);
  for (const workflowJob of Object.values(dbWorkflow.jobs)) for (const step of workflowJob.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    assert.ok(!step["continue-on-error"]);
  }
});

test("database wall-clock budgets reserve every test slot without excluding cases", () => {
  const config = readFileSync(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  const overrides = [...config.matchAll(/\[\[profile\.ci\.overrides\]\]\s*\nfilter = '([^']+)'\s*\nthreads-required = "([^"]+)"/g)];
  const budget = overrides.find(([, filter]) => filter === "test(/budget/)");
  assert.ok(budget, "database budget tests need exclusive execution");
  assert.equal(budget[2], "num-test-threads");
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

test("timing artifacts reject forks, expired artifacts and unrelated branches before preferring the current branch", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  const script = workflow.jobs["db-test-timing-source"].steps.find(step => step.id === "timings").run.split("node --input-type=module <<'JS'\n")[1].split("\nJS")[0];
  const root = mkdtempSync(path.join(tmpdir(), "trusted-timings-"));
  try {
    const artifact = (id, branch = "dev", overrides = {}) => ({ expired: false, created_at: "2026-11-01", workflow_run: { id, head_branch: branch, head_repository_id: 42, repository_id: 42 }, ...overrides });
    const invalid = [artifact(1, "unrelated"), artifact(2, "dev", { expired: true }),
      artifact(3, "dev", { workflow_run: { id: 3, head_branch: "dev", head_repository_id: 7, repository_id: 42 } }),
      artifact(4, "dev", { workflow_run: { id: 4, head_branch: "dev", head_repository_id: 42, repository_id: 7 } })];
    for (const [artifacts, expected] of [[invalid, ""], [[...invalid, artifact(5)], "run-id=5\n"],
      [[...invalid, artifact(6, "feature"), artifact(5, "dev", { created_at: "2026-11-02" }), artifact(7, "feature", { created_at: "2026-11-03" })], "run-id=7\n"]]) {
      writeFileSync(path.join(root, "db-test-timings.json"), JSON.stringify({ artifacts }));
      const output = path.join(root, "output"); writeFileSync(output, "");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: {
        ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_REPOSITORY_ID: "42", GITHUB_REF_NAME: "feature",
      } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(output, "utf8"), expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cache budget measures an archive containing registry and all restored target files", () => {
  const dbWorkflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  const budget = dbWorkflow.jobs["db-tests"].steps.find(step => step.id === "cache-budget");
  const root = mkdtempSync(path.join(tmpdir(), "cache-archive-"));
  try {
    const files = ["home/.cargo/registry/index/config.json", ...[".fingerprint", "build", "deps"].map(dir => `backend/target/debug/${dir}/artifact`)];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), file.repeat(100));
    }
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "temp"));
    // Keep tar's real input, with portable fixtures for compression and GNU stat.
    writeFileSync(path.join(root, "bin/zstd"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], fs.readFileSync(0));
`, { mode: 0o755 });
    writeFileSync(path.join(root, "bin/stat"), `#!${process.execPath}
console.log(require('node:fs').statSync(process.argv.at(-1)).size);
`, { mode: 0o755 });
    const output = path.join(root, "output"), summary = path.join(root, "summary");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", budget.run], { cwd: root, encoding: "utf8", env: {
      ...process.env, HOME: path.join(root, "home"), RUNNER_TEMP: path.join(root, "temp"), PATH: `${root}/bin:${process.env.PATH}`,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...budget.env,
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const archive = path.join(root, "temp/db-tests-rust-cache.tar.zst");
    const entries = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.equal(entries.status, 0, entries.stderr);
    const names = entries.stdout.trim().split("\n");
    assert.deepEqual(names.map(name => name.replace(/^.*\.cargo\//, "home/.cargo/")).sort(), files.sort());
    assert.ok(readFileSync(archive).length > 0);
    assert.match(readFileSync(summary, "utf8"), new RegExp(`candidate: ${readFileSync(archive).length} bytes`));
    assert.equal(readFileSync(output, "utf8"), "save=true\n");
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
    assert.ok(!step["continue-on-error"]);
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
