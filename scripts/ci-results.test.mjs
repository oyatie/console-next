// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

test("JUnit baseline reports known reds, refuses new reds, crashes, missing proof and expired quarantine", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-baseline-"));
  try {
    const baseline = path.join(dir, "baseline.json");
    const junit = path.join(dir, "junit.xml");
    const entry = { kind: "playwright", context: "chromium", suite: "person.spec.ts", test: "known red", owner: "test-owner", expires: "2099-01-01" };
    const set = (entries) => writeFileSync(baseline, JSON.stringify(entries));
    const report = (title, extra = "") => writeFileSync(junit, `<testsuites><testsuite tests="1" failures="1" errors="0"><testcase classname="person.spec.ts" name="${title}"><failure>withheld</failure></testcase>${extra}</testsuite></testsuites>`);
    const run = (status = "1") => spawnSync("python3", ["scripts/ci/test-results.py", "playwright", "chromium", junit, status, baseline], { encoding: "utf8" });
    set([entry]);
    report("known red @hr");
    assert.equal(run().status, 0);
    assert.equal(run("0").status, 1);
    report("new red");
    assert.equal(run().status, 1);
    report("known red", "<system-err>runner crashed</system-err><error>crash</error>");
    assert.equal(run().status, 1);
    report("known red");
    assert.equal(run("137").status, 1);
    for (const changed of [{ expires: "2000-01-01" }, { owner: "" }, { test: "" }]) {
      set([{ ...entry, ...changed }]);
      assert.equal(run().status, 1);
    }
    set([entry]);
    writeFileSync(junit, "<testsuites/>");
    assert.equal(run().status, 1);
    writeFileSync(junit, '<testsuites tests="0" errors="0" failures="0"/>');
    assert.equal(run("0").status, 1);
    const empty = spawnSync("python3", ["scripts/ci/test-results.py", "nextest", "unit", junit, "0", baseline], { encoding: "utf8" });
    assert.equal(empty.status, 0, empty.stderr);
    rmSync(junit);
    assert.equal(run().status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the trunk baseline can shrink but cannot grow, change owner/expiry, or move", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-baseline-ratchet-"));
  try {
    const config = JSON.parse(readFileSync(new URL("./ci/config.json", import.meta.url), "utf8"));
    const entries = JSON.parse(readFileSync(new URL("./ci/baseline.json", import.meta.url), "utf8"));
    writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='show'){process.stdout.write(a[1].endsWith('config.json')?process.env.BASE_CONFIG:process.env.BASE_ENTRIES);}\n`, { mode: 0o700 });
    const run = (old, oldConfig = config) => spawnSync("python3", ["scripts/ci/test-results.py", "--validate"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_BASE_SHA: "control", BASE_CONFIG: JSON.stringify(oldConfig), BASE_ENTRIES: JSON.stringify(old) } });
    assert.equal(run(entries).status, 0);
    assert.equal(run([...entries, { ...entries[0], test: "removed baseline red" }]).status, 0);
    assert.equal(run(entries.slice(1)).status, 1);
    assert.equal(run([{ ...entries[0], owner: "different owner" }, ...entries.slice(1)]).status, 1);
    assert.equal(run([{ ...entries[0], expires: "2099-01-01" }, ...entries.slice(1)]).status, 1);
    assert.equal(run(entries, { ...config, quarantineFile: "renamed.json" }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Rust package groups cover affected crates once and isolate the application", async () => {
  const { rustGroups } = await import("./ci/plan.mjs");
  const groups = rustGroups(["z", "app", "a", "b", "c"], "app", 2);
  assert.deepEqual(groups[0].crates, ["app"]);
  assert.deepEqual(groups.flatMap((group) => group.crates).sort(), ["a", "app", "b", "c", "z"]);
  assert.equal(groups.filter((group) => group.primary).length, 1);
  assert.ok(groups.every((group) => group.crates.length <= 2));
  assert.deepEqual(rustGroups([], undefined, 2), []);
});

test("frontend-only plans build the E2E backend without scheduling Rust test jobs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-frontend-plan-"));
  try {
    const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
    const packages = [{ name: "app", manifest_path: `${root}/backend/app/Cargo.toml`, dependencies: [], targets: [{ name: "app", kind: ["bin"], test: true }] }];
    writeFileSync(path.join(dir, "event.json"), JSON.stringify({ before: "base-sha" }));
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ packages }))});\n`, { mode: 0o700 });
    writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nprocess.stdout.write('apps/web/src/App.tsx\\0');\n`, { mode: 0o700 });
    const output = path.join(dir, "outputs");
    const result = spawnSync("node", ["scripts/ci/plan.mjs"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(dir, "event.json"), GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.equal(values.backend, "false");
    assert.equal(values.e2e, "true");
    assert.equal(values.unit, "false");
    assert.equal(values.db, "false");
    assert.equal(JSON.parse(values.buildMatrix).include.length, 1);
    assert.deepEqual(JSON.parse(values.unitMatrix).include, []);
    assert.deepEqual(JSON.parse(values.dbMatrix).include, []);
    const required = JSON.parse(values.required);
    assert.equal(required["rust-build"], true);
    assert.equal(required["backend-test"], false);
    assert.equal(required["backend-db"], false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("target groups retain mixed DB libraries and integration tests, bounded with no duplicate targets", async () => {
  const { rustGroups } = await import("./ci/plan.mjs");
  const pkg = (name, dependencies, targets) => ({ name, dependencies, targets, features: name === "app" ? { full: [], "test-postgres": [] } : {} });
  const target = (name, kind) => ({ name, kind: [kind], test: true });
  const packages = [pkg("data", [{ name: "sqlx" }], [target("data", "lib"), target("contract", "test")]), pkg("app", [{ name: "data" }], [target("app", "lib"), target("one", "test"), target("two", "test")]), pkg("plain", [], [target("plain", "lib"), target("integration", "test")])];
  const groups = rustGroups(packages.map((p) => p.name), "app", 2, packages);
  const targets = groups.flatMap((group) => group.targets);
  assert.equal(targets.length, 7);
  assert.equal(new Set(targets.map((t) => `${t.crate}:${t.target}`)).size, targets.length);
  assert.ok(groups.every((group) => group.targets.length <= 2 && group.modes.length === 1));
  assert.equal(targets.find((t) => t.crate === "data" && t.kind === "lib").mode, "db");
  assert.equal(targets.find((t) => t.crate === "app" && t.kind === "lib").mode, "db");
  assert.equal(targets.find((t) => t.crate === "plain" && t.kind === "lib").mode, "unit");
  assert.equal(targets.find((t) => t.target === "integration").mode, "db");
  for (const group of groups) for (const feature of group.features.split(",").filter(Boolean)) assert.ok(group.crates.includes(feature.split("/")[0]));
  assert.ok(groups.find((group) => group.crates.includes("app")).features.includes("app/full"));
  assert.throws(() => rustGroups(["future"], undefined, 2, [pkg("future", [], [target("future", "unknown-kind")])]), /unsupported Cargo test target/);
});

test("test archives and caches use bounded stripped builds and only the selected group", () => {
  const wf = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const build = wf.jobs["rust-build"];
  assert.equal(build.env.CARGO_PROFILE_TEST_DEBUG, "0");
  assert.equal(build.env.CARGO_PROFILE_TEST_STRIP, "debuginfo");
  assert.equal(build.env.CARGO_INCREMENTAL, "0");
  assert.ok(build.strategy.matrix.includes("buildMatrix"));
  assert.ok(build.steps.some((step) => step.run?.includes("scripts/ci/rust-build.mjs")));
  for (const [name, mode] of [["backend-test", "unit"], ["backend-db", "db"]]) {
    const job = wf.jobs[name];
    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
    assert.equal(download.with.name, `rust-tests-${mode}-${'${{ matrix.group }}'}`);
    assert.ok(job.strategy.matrix.includes(`${mode}Matrix`));
  }
});

test("Firefox retains the global server-expiry exclusion", () => {
  const result = spawnSync("node_modules/.bin/playwright", ["test", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, E2E_XBROWSER: "1" } });
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  assert.deepEqual(inventory.config.projects.map((project) => project.name), ["firefox"]);
  assert.ok(!inventory.suites.some((suite) => suite.file.includes("live-renew.server-expiry.spec.ts")));
});

test("baseline comparison is mandatory in browser and Rust runners", () => {
  for (const file of ["rust-tests.mjs", "e2e.mjs"]) {
    const script = readFileSync(new URL(`./ci/${file}`, import.meta.url), "utf8");
    assert.match(script, /test-results\.py/);
    assert.doesNotMatch(script, /continue-on-error|\|\| true/);
  }
});

test("disk budgets reject oversized builds, extractions and insufficient margin", () => {
  const result = spawnSync("python3", ["-c", `import importlib.util
s=importlib.util.spec_from_file_location('disk','scripts/ci/disk-budget.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c={'runnerDiskBudgetBytes':100,'runnerDiskMarginBytes':30}
m.enforce(80,90,40,c)
for values in [(101,90,40),(80,101,40),(80,90,29)]:
 try: m.enforce(*values,c)
 except ValueError: pass
 else: raise AssertionError(values)
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("actual roster generators keep unique phones and RRNs inside the synthetic rules", async () => {
  const { people } = await import("../e2e/helpers/import.ts");
  const { rrn } = await import("../e2e/helpers/import-layouts.ts");
  const { syntheticPhone, syntheticRrn, validRrnLines } = await import("./check-fixture-ids.mjs");
  const rows = people("CONTROL", 3000, ["합성 부서"], ["합성 사업장"]);
  assert.equal(new Set(rows.map((row) => row.phone)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.rrn)).size, rows.length);
  assert.throws(() => syntheticPhone(10000));
  assert.throws(() => syntheticRrn("invalid"));
  const text = JSON.stringify([...rows, { rrn: rrn("2001-01-01", 3, 101) }]);
  assert.deepEqual(validRrnLines(text), []);
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-roster-synthetic-"));
  try {
    writeFileSync(path.join(dir, "rows.json"), text);
    const result = spawnSync("node", ["scripts/ci/privacy.mjs", dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release tools refuse a well-formed archive with the wrong pinned checksum", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-tool-integrity-"));
  try {
    const archive = path.join(dir, "fixture.tar.gz");
    const binary = JSON.parse(readFileSync(new URL("./ci/versions.json", import.meta.url), "utf8")).nextest.binary;
    const create = spawnSync("python3", ["-c", "import io,sys,tarfile\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n i=tarfile.TarInfo(sys.argv[2]);data=b'#!/bin/sh\\nexit 0\\n';i.size=len(data);i.mode=0o755;t.addfile(i,io.BytesIO(data))", archive, binary], { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);
    writeFileSync(path.join(dir, "curl"), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.copyFileSync(process.env.TOOL_FIXTURE,a[a.indexOf('-o')+1]);\n`, { mode: 0o700 });
    const result = spawnSync("bash", ["scripts/ci/install-tools.sh", "nextest"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOOL_FIXTURE: archive, RUNNER_TEMP: dir, GITHUB_PATH: path.join(dir, "path") } });
    assert.notEqual(result.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Rust runner refuses invalid mode and partition before invoking Cargo", () => {
  for (const args of [["db", "0"], ["db", "999"], ["db", "1.5"], ["unknown", "1"]]) {
    const result = spawnSync("node", ["../scripts/ci/rust-tests.mjs", ...args], { cwd: new URL("../backend/", import.meta.url), encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid Rust test partition/);
  }
});

test("archive commands build their planned lib, bin and integration targets", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-archive-command-"));
  try {
    mkdirSync(path.join(dir, "backend"));
    const capture = path.join(dir, "args.json");
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const targets = ["lib", "bin", "test", "test"].map((kind, i) => ({ crate: i % 2 ? "a" : "b", kind, target: `target_${i}`, mode: "db" }));
    const group = { crates: ["a", "b"], targets, modes: ["db"], features: "app/full,app/test-postgres" };
    const result = spawnSync("node", [new URL("./ci/rust-build.mjs", import.meta.url).pathname], { cwd: path.join(dir, "backend"), encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, CI_RUST_GROUP: JSON.stringify(group) } });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(args.filter((arg) => arg === "--lib").length, 1);
    assert.equal(args.filter((arg) => arg === "--test").length, 2);
    assert.equal(args.filter((arg) => arg === "--bin").length, 1);
    assert.ok(!args.includes("--all-targets"));
    const filter = args[args.indexOf("-E") + 1];
    for (const target of targets) assert.ok(filter.includes(`binary(=${target.target})`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duration plan assigns only Firefox to its Firefox leg", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-browser-plan-"));
  try {
    const output = path.join(dir, "outputs");
    const result = spawnSync("node", ["scripts/ci/e2e.mjs", "plan"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, E2E_SERVED: "1" } });
    assert.equal(result.status, 0, result.stderr);
    const jobs = JSON.parse(readFileSync(output, "utf8").trim().replace(/^matrix=/, "")).include;
    assert.ok(jobs.some((job) => job.browser === "firefox"));
    for (const job of jobs) assert.equal(job.project === "firefox", job.browser === "firefox");
    for (const browser of ["chromium", "firefox"]) assert.ok(jobs.find((job) => job.browser === browser && job.shard === 1).files.includes("first-run-solo.spec.ts"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browser runner reports baselined failures and publishes a trace flag only when present", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-browser-outcome-"));
  try {
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
    const config = readFileSync(new URL("./ci/config.json", import.meta.url), "utf8");
    writeFileSync(path.join(dir, "scripts/ci/config.json"), config);
    symlinkSync(new URL("./ci/test-results.py", import.meta.url).pathname, path.join(dir, "scripts/ci/test-results.py"));
    const entry = JSON.parse(readFileSync(new URL("./ci/baseline.json", import.meta.url), "utf8")).find((e) => e.kind === "playwright" && e.context === "chromium");
    const escape = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const junit = `<testsuites><testsuite errors="0"><testcase classname="${escape(entry.suite)}" name="${escape(entry.test)}"><failure>synthetic failure</failure></testcase></testsuite></testsuites>`;
    writeFileSync(path.join(dir, "node_modules/.bin/playwright"), `#!${process.execPath}\nconst f=require('node:fs');f.mkdirSync('.cache/ci/e2e-results',{recursive:true});f.writeFileSync('.cache/ci/e2e-results/junit.xml',${JSON.stringify(junit)});if(process.env.TRACE_FIXTURE==='1'){f.mkdirSync('test-results',{recursive:true});f.writeFileSync('test-results/trace.zip','fixture');}process.exit(1);\n`, { mode: 0o700 });
    for (const traces of [true, false]) {
      rmSync(path.join(dir, "test-results"), { recursive: true, force: true });
      const output = path.join(dir, `output-${traces}`);
      const result = spawnSync("node", [new URL("./ci/e2e.mjs", import.meta.url).pathname, "run"], { cwd: dir, encoding: "utf8", env: { ...process.env, PLAYWRIGHT_JUNIT_OUTPUT_FILE: ".cache/ci/e2e-results/junit.xml", GITHUB_OUTPUT: output, TRACE_FIXTURE: traces ? "1" : "0", SHARD: JSON.stringify({ browser: "chromium", project: "parallel", files: ["fixture.spec.ts"] }) } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8").trim(), `traces=${traces}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Rust runner reads nextest's workspace JUnit and refuses stale reports", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-rust-report-"));
  try {
    mkdirSync(path.join(dir, "backend"));
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/config.json"), readFileSync(new URL("./ci/config.json", import.meta.url)));
    symlinkSync(new URL("./ci/test-results.py", import.meta.url).pathname, path.join(dir, "scripts/ci/test-results.py"));
    const entry = JSON.parse(readFileSync(new URL("./ci/baseline.json", import.meta.url), "utf8")).find((e) => e.kind === "nextest" && e.context === "db");
    const junit = `<testsuites><testsuite errors="0"><testcase classname="${entry.suite}" name="${entry.test}"><failure>fixture failure</failure></testcase></testsuite></testsuites>`;
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nconst f=require('node:fs');if(process.env.NO_JUNIT!=='1'){f.mkdirSync('target/nextest/ci',{recursive:true});f.writeFileSync('target/nextest/ci/junit.xml',${JSON.stringify(junit)});process.exit(100);}\n`, { mode: 0o700 });
    const run = (missing) => spawnSync("node", [new URL("./ci/rust-tests.mjs", import.meta.url).pathname, "db", "1"], { cwd: path.join(dir, "backend"), encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NO_JUNIT: missing ? "1" : "0" } });
    assert.equal(run(false).status, 0);
    assert.equal(run(true).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
