// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";
import "./ci-regressions.test.mjs";

test("CI folds shard durations into restored history with the existing rolling average", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-rolling-timings-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    copyFileSync(new URL("./e2e-timings.mjs", import.meta.url), path.join(dir, "scripts/e2e-timings.mjs"));
    mkdirSync(path.join(dir, ".cache/e2e-timings"), { recursive: true });
    const file = path.join(dir, ".cache/e2e-timings/timings.json");
    const at = Date.now();
    writeFileSync(file, JSON.stringify({ untouched: { s: 8, at }, repeated: { s: 20, at }, stale: { s: 4, at: 0 } }));
    for (const [shard, values] of [[1, { repeated: { s: 40, at } }], [2, { added: { s: 12, at } }]]) {
      const target = path.join(dir, `.cache/ci/e2e-collected/shard-${shard}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "timings.json"), JSON.stringify(values));
    }
    const wf = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const step = wf.jobs["ci-ok"].steps.find((s) => s.name === "Merge measured durations");
    const result = spawnSync("bash", ["-e", "-c", step.run], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const timings = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(timings.untouched, { s: 8, at });
    assert.equal(timings.repeated.s, 30);
    assert.equal(timings.added.s, 12);
    assert.equal(timings.stale, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test("owned Playwright test timeouts are reds; worker crashes and unaccounted errors stay blocking", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-timeout-junit-"));
  try {
    const baseline = path.join(dir, "baseline.json"), junit = path.join(dir, "junit.xml");
    const entry = { kind: "playwright", context: "chromium", suite: "slow.spec.ts", test: "known timeout", owner: "ci-1", expires: "2099-01-01" };
    writeFileSync(baseline, JSON.stringify([entry]));
    const run = (message = "Test timeout of 120000ms exceeded.", { kind = "playwright", title = entry.test, status = "1", errors = 1, outside = "" } = {}) => {
      writeFileSync(baseline, JSON.stringify([{ ...entry, kind }]));
      writeFileSync(junit, `<testsuites errors="${errors}"><testsuite><testcase classname="${entry.suite}" name="${title}"><error message="${message}" type="Error">withheld</error></testcase>${outside}</testsuite></testsuites>`);
      return spawnSync("python3", ["scripts/ci/test-results.py", kind, "chromium", junit, status, baseline], { encoding: "utf8" });
    };
    assert.equal(run().status, 0);
    assert.equal(run(undefined, { title: "new timeout" }).status, 1);
    assert.equal(run(undefined, { status: "0" }).status, 1);
    assert.equal(run(undefined, { errors: 2 }).status, 1);
    assert.equal(run(undefined, { outside: '<error message="Test timeout of 120000ms exceeded."/>' }).status, 1);
    assert.equal(run("Worker process exited unexpectedly").status, 1);
    assert.equal(run("Test timeout of invalidms exceeded.").status, 1);
    assert.equal(run(undefined, { kind: "nextest", status: "100" }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the strict baseline can shrink or expire sooner but cannot grow, change owner, or move", () => {
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
    assert.equal(run([{ ...entries[0], expires: "2099-01-01" }, ...entries.slice(1)]).status, 0);
    assert.equal(run(entries, { ...config, quarantineFile: "renamed.json" }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one archive covers the affected Rust closure with disjoint DB and unit filters", async () => {
  const { rustBuild } = await import("./ci/plan.mjs");
  const packages = [
    { name: "db", dependencies: [{ name: "sqlx" }], features: {} },
    { name: "app", dependencies: [{ name: "db" }], features: { full: [], "test-postgres": [] } },
    { name: "plain", dependencies: [], features: {} },
  ];
  const build = rustBuild(["app", "db", "plain"], packages);
  assert.deepEqual(build.crates, ["app", "db", "plain"]);
  assert.equal(build.features, "app/full,app/test-postgres");
  assert.equal(build.unitFilter, "kind(lib) & not (package(=app) + package(=db))");
  assert.equal(build.dbFilter, `not (${build.unitFilter})`);
});

test("plan budgets the workflow timeout chain; job-minutes warn without blocking", async () => {
  const { planBudget } = await import("./ci/plan.mjs");
  const c = JSON.parse(readFileSync(new URL("./ci/config.json", import.meta.url), "utf8"));
  const p = { backend: true, web: true, e2e: true, unit: true, db: true };
  const jobs = [{ browser: "chromium", shard: 1, est: 300 }, { browser: "firefox", shard: 1, est: 300 }];
  const proof = planBudget(p, c, jobs);
  const reservation = planBudget(p, c);
  assert.ok(c.maxJobs >= Math.ceil(reservation.jobs * 1.25));
  assert.ok(c.maxTotalMinutes >= Math.ceil(reservation.minutes * 1.25));
  assert.equal(proof.wallMinutes, 200);
  assert.ok(proof.wallMinutes < proof.queueMinutes);
  assert.equal(proof.perJob["e2e-chromium-1"], 5.5);
  assert.throws(() => planBudget(p, { ...c, maxJobs: proof.jobs - 1 }, jobs), /job budget/);
  assert.doesNotThrow(() => planBudget(p, { ...c, maxTotalMinutes: proof.minutes - 1 }, jobs));
  const wf = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.throws(() => planBudget(p, c, [{ est: 60 * wf.jobs.e2e["timeout-minutes"] }]), /timeout headroom/);
  wf.jobs["rust-build"]["timeout-minutes"] = proof.queueMinutes;
  assert.throws(() => planBudget(p, c, jobs, wf.jobs), /merge-queue timeout/);
  assert.ok(planBudget({ backend: false, web: false, e2e: false }, c, []).minutes < proof.minutes);
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
    assert.equal(JSON.parse(values.build).crates.length, 1);
    assert.deepEqual(JSON.parse(values.unitMatrix).include, []);
    assert.deepEqual(JSON.parse(values.dbMatrix).include, []);
    const required = JSON.parse(values.required);
    assert.equal(required["rust-build"], true);
    assert.equal(required["backend-test"], false);
    assert.equal(required["backend-db"], false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("archive consumers share the single stripped build and use partitions", () => {
  const wf = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const build = wf.jobs["rust-build"];
  assert.equal(build.env.CARGO_PROFILE_TEST_DEBUG, "0");
  assert.equal(build.env.CARGO_PROFILE_TEST_STRIP, "symbols");
  assert.equal(build.strategy, undefined);
  const queue = JSON.parse(readFileSync(new URL("../.github/rulesets/dev.json", import.meta.url), "utf8")).rules.find((r) => r.type === "merge_queue");
  const config = JSON.parse(readFileSync(new URL("./ci/config.json", import.meta.url), "utf8"));
  assert.ok(queue.parameters.check_response_timeout_minutes > build["timeout-minutes"]);
  for (const name of ["backend-test", "backend-db"]) {
    const download = wf.jobs[name].steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
    assert.equal(download.with.name, "rust-tests");
  }
  const runner = readFileSync(new URL("./ci/rust-tests.mjs", import.meta.url), "utf8");
  assert.match(runner, /--archive-file/);
  assert.match(runner, /--partition/);
  assert.doesNotMatch(runner, /nextest", "archive/);
  const e2e = wf.jobs.e2e;
  assert.equal(e2e.env.E2E_PREBUILT, "1");
  for (const name of ["backend-binary", "web-dist"]) assert.ok(e2e.steps.some((s) => s.with?.name === name));
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

for (const tool of ["nextest", "actionlint"]) test(`${tool} refuses a well-formed archive with the wrong pinned checksum`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-tool-integrity-"));
  try {
    const archive = path.join(dir, "fixture.tar.gz");
    const binary = JSON.parse(readFileSync(new URL("./ci/versions.json", import.meta.url), "utf8"))[tool].binary;
    const create = spawnSync("python3", ["-c", "import io,sys,tarfile\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n i=tarfile.TarInfo(sys.argv[2]);data=b'#!/bin/sh\\nexit 0\\n';i.size=len(data);i.mode=0o755;t.addfile(i,io.BytesIO(data))", archive, binary], { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);
    writeFileSync(path.join(dir, "curl"), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.copyFileSync(process.env.TOOL_FIXTURE,a[a.indexOf('-o')+1]);\n`, { mode: 0o700 });
    const result = spawnSync("bash", ["scripts/ci/install-tools.sh", tool], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOOL_FIXTURE: archive, RUNNER_TEMP: dir, GITHUB_PATH: path.join(dir, "path") } });
    assert.notEqual(result.status, 0);
    assert.equal(spawnSync("test", ["-e", path.join(dir, "console-tools/bin", binary)]).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Rust runner refuses invalid mode and partition before invoking Cargo", () => {
  for (const args of [["db", "0"], ["db", "999"], ["db", "1.5"], ["unknown", "1"]]) {
    const result = spawnSync("node", ["../scripts/ci/rust-tests.mjs", ...args], { cwd: new URL("../backend/", import.meta.url), encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid Rust test partition/);
  }
});

test("archive command builds all selected packages in one Cargo invocation", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-archive-command-"));
  try {
    mkdirSync(path.join(dir, "backend"));
    const capture = path.join(dir, "args.json");
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o700 });
    const result = spawnSync("node", [new URL("./ci/rust-build.mjs", import.meta.url).pathname], { cwd: path.join(dir, "backend"), encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, CI_RUST_BUILD: JSON.stringify({ crates: ["a", "b"], features: "a/full" }) } });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ["nextest", "archive"]);
    assert.ok(calls[0].includes("--tests"));
    assert.deepEqual(calls[0].filter((arg, i, args) => args[i - 1] === "-p"), ["a", "b"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duration plan assigns only Firefox to its Firefox leg", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-browser-plan-"));
  try {
    const output = path.join(dir, "outputs");
    const result = spawnSync("node", ["scripts/ci/e2e.mjs", "plan"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, E2E_SERVED: "1", E2E_TIMINGS_FILE: path.join(dir, "timings.json") } });
    assert.equal(result.status, 0, result.stderr);
    const jobs = JSON.parse(readFileSync(output, "utf8").split("\n").find((line) => line.startsWith("matrix=")).slice(7)).include;
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
    writeFileSync(path.join(dir, "scripts/ci/baseline.json"), "[]");
    copyFileSync(new URL("./ci/test-results.py", import.meta.url), path.join(dir, "scripts/ci/test-results.py"));
    const entry = JSON.parse(readFileSync(new URL("./ci/baseline.json", import.meta.url), "utf8")).find((e) => e.kind === "playwright" && e.context === "chromium");
    writeFileSync(path.join(dir, "scripts/ci/baseline.json"), JSON.stringify([entry]));
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
    copyFileSync(new URL("./ci/test-results.py", import.meta.url), path.join(dir, "scripts/ci/test-results.py"));
    writeFileSync(path.join(dir, "scripts/ci/disk-budget.py"), "# synthetic disk receipt\n");
    const entry = { kind: "nextest", context: "db", suite: "synthetic::db", test: "known red", owner: "Jason Lee", expires: "2099-01-01" };
    writeFileSync(path.join(dir, "scripts/ci/baseline.json"), JSON.stringify([entry]));
    const junit = `<testsuites><testsuite errors="0"><testcase classname="${entry.suite}" name="${entry.test}"><failure>fixture failure</failure></testcase></testsuite></testsuites>`;
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nconst f=require('node:fs');if(process.argv.includes('list')){process.stdout.write(JSON.stringify({'rust-suites':{[process.env.SUITE]:{testcases:{[process.env.TEST]:{}}}}}));process.exit(0);}if(process.env.NO_JUNIT!=='1'){f.mkdirSync('target/nextest/ci',{recursive:true});f.writeFileSync('target/nextest/ci/junit.xml',${JSON.stringify(junit)});process.exit(100);}\n`, { mode: 0o700 });
    const run = (missing) => spawnSync("node", [new URL("./ci/rust-tests.mjs", import.meta.url).pathname, "db", "1"], { cwd: path.join(dir, "backend"), encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_RUST_BUILD: JSON.stringify({ crates: [entry.suite.split("::")[0]], dbFilter: "all()" }), SUITE: entry.suite, TEST: entry.test, NO_JUNIT: missing ? "1" : "0" } });
    const result = run(false);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(run(true).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("flaky quarantine accepts pass and failure only with disagreeing run receipts and a short expiry", () => {
  const result = spawnSync("python3", ["-c", `import importlib.util,json,tempfile,datetime
from pathlib import Path
s=importlib.util.spec_from_file_location('results','scripts/ci/test-results.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
today=datetime.date.today();date=today.isoformat()
e={'kind':'playwright','context':'chromium','suite':'synthetic.spec.ts','test':'flake','owner':'Jason Lee','class':'flaky','expires':(today+datetime.timedelta(days=3)).isoformat(),'evidence':[{'runId':'run-pass','date':date,'result':'passed'},{'runId':'run-fail','date':date,'result':'failed'}]}
with tempfile.TemporaryDirectory() as d:
 p=Path(d)/'baseline.json';j=Path(d)/'junit.xml'
 p.write_text(json.dumps([e]));entries=m.baseline(p)
 for failure,status in [('',0),('<failure/>',1)]:
  j.write_text('<testsuites><testsuite><testcase classname="synthetic.spec.ts" name="flake">'+failure+'</testcase></testsuite></testsuites>')
  assert m.check('playwright','chromium',j,status,entries)==0
 for change in [{'evidence':[]},{'class':'unknown'},{'evidence':[dict(e['evidence'][0],runId=''),e['evidence'][1]]},{'evidence':[dict(e['evidence'][0],date=(today+datetime.timedelta(days=1)).isoformat()),e['evidence'][1]]},{'evidence':[e['evidence'][0]]},{'evidence':[e['evidence'][0],dict(e['evidence'][1],result='passed')]},{'expires':(today+datetime.timedelta(days=8)).isoformat()},{'evidence':[e['evidence'][0],dict(e['evidence'][1],runId='run-pass')]}]:
  p.write_text(json.dumps([dict(e,**change)]))
  try: m.baseline(p)
  except ValueError: pass
  else: raise AssertionError(change)
 p.write_text(json.dumps([e]));m.CONFIG["baselineMaxFlaky"]=0
 try: m.baseline(p)
 except ValueError: pass
 else: raise AssertionError("flake budget ignored")
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("expiry renewal needs a fresh run ID and cannot add IDs or change ownership", () => {
  const result = spawnSync("python3", ["-c", `import importlib.util,datetime
s=importlib.util.spec_from_file_location('results','scripts/ci/test-results.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
today=datetime.date.today();date=today.isoformat()
e={'kind':'nextest','context':'unit','suite':'synthetic','test':'red','owner':'Jason Lee','class':'deterministic','expires':(today+datetime.timedelta(days=2)).isoformat()}
new=dict(e,expires=(today+datetime.timedelta(days=9)).isoformat())
receipt={'runId':'new-tip-run','date':date,'result':'failed'}
m.validate_changes([dict(new,evidence=[receipt])],[e])
m.validate_changes([dict(e,**{'class':'flaky','evidence':[receipt,dict(receipt,runId='pass-run',result='passed')]})],[e])
m.validate_changes([dict(e,expires=(today+datetime.timedelta(days=1)).isoformat())],[e])
for entries,old in [([new],[e]),([dict(new,evidence=[receipt])],[dict(e,evidence=[receipt])]),([dict(new,evidence=[dict(receipt,date=(today-datetime.timedelta(days=1)).isoformat())])],[e]),([dict(new,expires=(today+datetime.timedelta(days=30)).isoformat(),evidence=[receipt])],[e]),([dict(e,test='new')],[e]),([dict(e,owner='changed')],[e]),([dict(e,**{'class':'flaky'})],[e])]:
 try: m.validate_changes(entries,old)
 except ValueError: pass
 else: raise AssertionError(entries)
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("served timings at twice the seed pack within the cap and report predicted minutes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-slower-plan-"));
  try {
    const seed = JSON.parse(readFileSync(new URL("./ci/e2e-timings.json", import.meta.url), "utf8"));
    const timings = path.join(dir, "timings.json");
    writeFileSync(timings, JSON.stringify(Object.fromEntries(Object.entries(seed).filter(([k]) => k !== "_license").map(([k, v]) => [k, { ...v, s: v.s * 2 }]))));
    const output = path.join(dir, "outputs");
    const result = spawnSync("node", ["scripts/ci/e2e.mjs", "plan"], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, E2E_SERVED: "1", E2E_TIMINGS_FILE: timings } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const config = JSON.parse(readFileSync(new URL("./ci/config.json", import.meta.url), "utf8"));
    const jobs = JSON.parse(readFileSync(output, "utf8").split("\n").find((line) => line.startsWith("matrix=")).slice(7)).include;
    assert.ok(jobs.length <= config.e2eMaxShards);
    assert.match(result.stdout, /Predicted per-job minutes/);
    for (const browser of ["chromium", "firefox"]) assert.ok(jobs.find((job) => job.browser === browser && job.shard === 1).files.includes("first-run-solo.spec.ts"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const runner of ["nextest", "playwright"]) test(`${runner} runner refuses a failed inventory even when its JSON is valid`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-inventory-exit-"));
  try {
    for (const sub of ["backend", "scripts/ci", "node_modules/.bin"]) mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/config.json"), readFileSync(new URL("./ci/config.json", import.meta.url)));
    writeFileSync(path.join(dir, "scripts/ci/baseline.json"), "[]");
    writeFileSync(path.join(dir, "scripts/ci/disk-budget.py"), "# synthetic disk receipt\n");
    copyFileSync(new URL("./ci/test-results.py", import.meta.url), path.join(dir, "scripts/ci/test-results.py"));
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nconst f=require('node:fs');if(process.argv.includes('list')){process.stdout.write(JSON.stringify({'rust-suites':{}}));process.exit(42);}f.mkdirSync('target/nextest/ci',{recursive:true});f.writeFileSync('target/nextest/ci/junit.xml','<testsuites tests="0" failures="0"/>');\n`, { mode: 0o700 });
    const spec = { title: "synthetic", tests: [{ projectName: "parallel", expectedStatus: "passed" }] };
    writeFileSync(path.join(dir, "node_modules/.bin/playwright"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ suites: [{ file: "synthetic.spec.ts", specs: [spec] }] }))});process.exit(42);\n`, { mode: 0o700 });
    const result = spawnSync("node", [new URL(`./ci/${runner === "nextest" ? "rust-tests" : "e2e"}.mjs`, import.meta.url).pathname, ...(runner === "nextest" ? ["unit", "1"] : ["plan"])], { cwd: runner === "nextest" ? path.join(dir, "backend") : dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_RUST_BUILD: JSON.stringify({ crates: [], full: true, unitFilter: "all()" }), GITHUB_OUTPUT: path.join(dir, "output") } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${runner === "nextest" ? "nextest archive" : "Playwright"} inventory failed`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const runner of ["nextest", "playwright"]) test(`${runner} runner propagates stale baseline inventory despite a successful listing`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-stale-inventory-"));
  try {
    for (const sub of ["backend", "scripts/ci", "node_modules/.bin"]) mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/config.json"), readFileSync(new URL("./ci/config.json", import.meta.url)));
    copyFileSync(new URL("./ci/test-results.py", import.meta.url), path.join(dir, "scripts/ci/test-results.py"));
    writeFileSync(path.join(dir, "scripts/ci/disk-budget.py"), "# synthetic disk receipt\n");
    const entry = { kind: runner, context: runner === "nextest" ? "unit" : "chromium", suite: runner === "nextest" ? "synthetic::binary" : "synthetic.spec.ts", test: "deleted", owner: "Jason Lee", expires: "2099-01-01" };
    writeFileSync(path.join(dir, "scripts/ci/baseline.json"), JSON.stringify([entry]));
    const spec = (title) => ({ title, tests: [{ projectName: "parallel", expectedStatus: "passed" }] });
    const inventories = runner === "nextest"
      ? [false, true].map((present) => ({ "rust-suites": { [entry.suite]: { testcases: present ? { [entry.test]: {} } : {} } } }))
      : [false, true].map((present) => ({ suites: [{ file: entry.suite, specs: [spec("unrelated"), ...(present ? [spec(entry.test)] : [])] }] }));
    const listing = `process.stdout.write(JSON.stringify(${JSON.stringify(inventories)}[process.env.TEST_PRESENT==='1'?1:0]));`;
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nconst f=require('node:fs');if(process.argv.includes('list')){${listing}process.exit(0);}f.mkdirSync('target/nextest/ci',{recursive:true});f.writeFileSync('target/nextest/ci/junit.xml','<testsuites><testsuite tests="1" failures="0"><testcase classname="unrelated" name="passed"/></testsuite></testsuites>');\n`, { mode: 0o700 });
    writeFileSync(path.join(dir, "node_modules/.bin/playwright"), `#!${process.execPath}\n${listing}\n`, { mode: 0o700 });
    const run = (present) => spawnSync(process.execPath, [new URL(`./ci/${runner === "nextest" ? "rust-tests" : "e2e"}.mjs`, import.meta.url).pathname, ...(runner === "nextest" ? ["unit", "1"] : ["plan"])], {
      cwd: runner === "nextest" ? path.join(dir, "backend") : dir, encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_PRESENT: present ? "1" : "0", CI_RUST_BUILD: JSON.stringify({ crates: ["synthetic"], full: true, unitFilter: "all()" }), CI_PLAN: JSON.stringify({ e2e: "true", browsers: '["chromium"]' }), GITHUB_OUTPUT: path.join(dir, "output") },
    });
    const stale = run(false);
    assert.equal(stale.status, 1, stale.stderr + stale.stdout);
    assert.match(stale.stderr + stale.stdout, /absent tests; remove from baseline/);
    if (runner === "playwright") assert.match(stale.stderr, /stale browser baseline/);
    const valid = run(true);
    assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
