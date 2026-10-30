// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { classifyTests, databaseTests, verifyJUnit } from "./backend-tests.mjs";

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
  const s = suite(["ordinary", "known_ignored"]);
  s.testcases.known_ignored.ignored = true;
  const result = classifyTests(listing(s), new Map([["example", new Set()]]));
  assert.deepEqual(result.ignored, [["example::mixed", "known_ignored"]]);
  assert.equal(result.selected.length, 1);
  assert.deepEqual(classifyTests(listing(s), new Map([["example", new Set(["known_ignored"])]] )).ignored, result.ignored);
  assert.throws(() => classifyTests(listing(s), new Map()), /missing/);
  assert.throws(() => classifyTests(listing({ ...s, status: "skipped" }), new Map([["example", new Set()]])), /listed/);
  assert.throws(() => classifyTests(listing(), new Map()), /zero/);
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
    writeFileSync(path.join(root, "lib.rs"), '#[test] fn ordinary() {}\n#[sqlx::test] async fn database(pool: PgPool) {}\n#[cfg(feature = "test-postgres")] #[sqlx::test] async fn feature_database() {}');
    const s = suite(["ordinary", "database", "tooling"]);
    s.testcases.tooling.ignored = true;
    writeFileSync(path.join(root, "metadata.json"), JSON.stringify({ workspace_root: root, target_directory: path.join(root, "custom-build-cache"), packages: [{ id: "example", manifest_path: path.join(root, "Cargo.toml") }] }));
    writeFileSync(path.join(root, "list.json"), JSON.stringify(listing(s)));
    const cargo = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2);
if (process.env.DATABASE_URL || process.env.PGHOST) process.exit(91);
if (args[0] === 'metadata') process.stdout.write(fs.readFileSync(path.join(root, 'metadata.json')));
else if (args[1] === 'list') {
  process.stdout.write(fs.readFileSync(path.join(root, 'list.json')));
  if (process.env.MODE === 'spawn-error') fs.unlinkSync(__filename);
}
else {
  fs.writeFileSync(path.join(root, 'args.json'), JSON.stringify(args));
  if (process.env.MODE !== 'missing') fs.copyFileSync(path.join(root, 'result.xml'), path.join(root, 'target/nextest/ci/junit.xml'));
  process.exit(process.env.MODE === 'exit' ? 100 : 0);
}
`;
    for (const mode of ["pass", "failure", "exit", "missing", "skipped", "spawn-error"]) {
      writeFileSync(path.join(root, "bin/cargo"), cargo, { mode: 0o755 });
      writeFileSync(path.join(root, "result.xml"), junit([["example::mixed", "ordinary"]], mode === "skipped" ? "<skipped/>" : "", mode === "failure" ? 1 : 0));
      const result = spawnSync(process.execPath, [new URL("./backend-tests.mjs", import.meta.url).pathname], { encoding: "utf8", env: { ...process.env, PATH: `${root}/bin`, FIXTURE_ROOT: root, MODE: mode, DATABASE_URL: "postgres://unused.invalid/db", PGHOST: "unused.invalid", GITHUB_STEP_SUMMARY: path.join(root, "summary.md") } });
      assert.equal(result.status, mode === "pass" ? 0 : 1, result.stdout + result.stderr);
      if (mode === "spawn-error") assert.match(result.stderr, /spawnSync cargo ENOENT/);
      assert.equal(JSON.parse(readFileSync(path.join(root, "target/nextest/ci/inventory.json"), "utf8")).selected.length, 1);
    }
    const args = JSON.parse(readFileSync(path.join(root, "args.json"), "utf8"));
    for (const flag of ["--workspace", "--locked", "--no-fail-fast", "--ignore-default-filter"]) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf("--run-ignored") + 1], "default");
    assert.ok(readFileSync(path.join(root, "summary.md"), "utf8").includes("1/1 non-database tests passed"));
    assert.match(readFileSync(path.join(root, "summary.md"), "utf8"), /3 deferred \(1 listed database tests, 1 explicitly ignored, 1 feature-gated/);
    assert.match(readFileSync(path.join(root, "summary.md"), "utf8"), /Ignored by source attribute: `example::mixed \/ tooling`/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backend tests inherit hardening, pinned tooling, JUnit artifacts and blocking ci-ok wiring", () => {
  const job = workflow.jobs.backend;
  assert.ok(job, "backend checks and tests must execute in CI");
  assert.ok(!workflow.jobs["backend-tests"], "nextest shares the existing backend build directory");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.env.SQLX_OFFLINE, "true");
  assert.match(job.env.CARGO_NEXTEST_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!job["continue-on-error"] && !job.if);
  assert.ok(job.steps[0].uses.startsWith("step-security/harden-runner@"));
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    assert.ok(!step["continue-on-error"]);
  }
  const run = job.steps.find((s) => s.run === "node scripts/backend-tests.mjs");
  assert.ok(run && !run.if);
  assert.equal(run["working-directory"], ".");
  assert.ok(job.steps.indexOf(run) > job.steps.findIndex((s) => s.run?.startsWith("cargo clippy ")));
  const check = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.check;
  assert.match(check, /node --test[^&]*scripts\/backend-tests\.test\.mjs/);
  const install = job.steps.find((s) => s.name === "Install pinned Rust test runner");
  assert.ok(install.run.includes("releases/download/cargo-nextest-${CARGO_NEXTEST_VERSION}/"));
  assert.match(install.run, /[a-f0-9]{64}.*sha256sum -c -/);
  const artifact = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === "backend-test-results");
  assert.equal(artifact.if, "${{ !cancelled() }}");
  assert.equal(artifact.with["if-no-files-found"], "error");
  assert.ok(workflow.jobs["ci-ok"].needs.includes("backend"));
  const command = workflow.jobs["ci-ok"].steps.map((s) => s.run ?? "").join("\n");
  for (const status of ["success", "failure", "cancelled", "skipped"]) {
    const shell = command.replace(/\$\{\{ needs(?:\.([\w-]+)|\['([\w-]+)'\])\.result \}\}/g, (_, dotted, quoted) => (dotted ?? quoted) === "backend" ? status : "success");
    assert.equal(spawnSync("bash", ["-e", "-c", shell]).status, status === "success" ? 0 : 1);
  }
});

test("clippy and nextest reuse a Rust cache that only trusted dev pushes can save", () => {
  const steps = workflow.jobs.backend.steps;
  const restore = steps.find((s) => s.uses?.startsWith("actions/cache/restore@"));
  const save = steps.find((s) => s.uses?.startsWith("actions/cache/save@"));
  assert.ok(restore && save);
  assert.match(restore.with.path, /backend\/target/);
  assert.match(restore.with.path, /\.cargo\/registry/);
  for (const input of ["backend/rust-toolchain.toml", "backend/Cargo.lock", "backend/**/Cargo.toml"])
    assert.ok(restore.with.key.includes(input));
  for (const input of ["runner.os", "runner.arch", "github.sha"])
    assert.ok(restore.with.key.includes(input));
  assert.equal(save.with.key, "${{ steps.rust-cache.outputs.cache-primary-key }}");
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.if, "github.event_name == 'push' && github.ref == 'refs/heads/dev'");
  assert.ok(steps.indexOf(restore) < steps.findIndex((s) => s.run?.startsWith("cargo clippy ")));
  assert.ok(steps.indexOf(save) > steps.findIndex((s) => s.run === "node scripts/backend-tests.mjs"));
  const pins = steps.filter((s) => s.uses?.startsWith("actions/setup-node@")).map((s) => s.uses);
  assert.deepEqual(pins, [workflow.jobs.web.steps.find((s) => s.uses?.startsWith("actions/setup-node@")).uses]);
});
