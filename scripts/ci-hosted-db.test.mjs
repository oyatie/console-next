// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

test("each DB partition compares independently compiled base and head sources in this hosted run", () => {
  const jobs = load(readFileSync(".github/workflows/ci.yml", "utf8")).jobs;
  assert.equal(jobs["rust-build"].strategy.matrix, "${{ fromJSON(needs.plan.outputs.rustMatrix) }}");
  for (const name of ["rust-build", "backend-db"]) {
    const job = jobs[name];
    assert.equal(job.env.CI_HOSTED_SOURCE, "${{ matrix.source }}");
    assert.equal(job.env.CI_BASE_SHA, "${{ needs.plan.outputs.base }}");
    assert.ok(job.steps.some((s) => s.run === "node scripts/ci/hosted-source.mjs"));
  }
  const artifact = jobs["backend-db"].steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
  assert.match(artifact.with.name, /matrix.source/);
  const gate = jobs["ci-ok"].steps.findIndex((s) => s.run === "node scripts/ci/gate.mjs");
  const receipts = jobs["ci-ok"].steps.findIndex((s) => s.with?.pattern === "backend-db-junit-*");
  assert.ok(receipts >= 0 && receipts < gate);
});

test("hosted DB evidence refuses stale/missing partitions, unowned reds, crashes, and a recovered quarantine", () => {
  const result = spawnSync("python3", ["-c", `import importlib.util,json,tempfile,os
from pathlib import Path
s=importlib.util.spec_from_file_location('hosted','scripts/ci/hosted-db.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
env={'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'2','CI_BASE_SHA':'a'*40,'CI_HEAD_SHA':'b'*40}
os.environ.update(env)
ident=['nextest','db','synthetic::db','standing']
entry=dict(zip(('kind','context','suite','test'),ident),owner='Jason Lee',expires='2099-01-01')
with tempfile.TemporaryDirectory() as d:
 root=Path(d);policy=root/'quarantine.json';policy.write_text(json.dumps([entry]))
 junit=root/'junit.xml';junit.write_text('<testsuites><testsuite><testcase classname="synthetic::db" name="standing"><failure/></testcase></testsuite></testsuites>')
 reports={}
 for source in ('base','head'):
  os.environ.update(CI_HOSTED_SOURCE=source,CI_SOURCE_SHA=env['CI_BASE_SHA' if source=='base' else 'CI_HEAD_SHA'])
  report=m.record(junit,100,1,1);reports[source]=root/source/'junit.baseline.json'
  reports[source].parent.mkdir();reports[source].write_text(json.dumps(report))
 assert m.compare(root,1,policy)==0
 original=json.loads(reports['base'].read_text())
 for field,value in [('runId','122'),('attempt','1'),('sha','c'*40),('baseSha','c'*40),('headSha','c'*40),('partition',2),('partitions',2),('source','head')]:
  reports['base'].write_text(json.dumps(dict(original,**{field:value})))
  try: m.compare(root,1,policy)
  except ValueError: pass
  else: raise AssertionError(field)
 reports['base'].write_text(json.dumps(original))
 try: m.compare(root,2,policy)
 except ValueError: pass
 else: raise AssertionError('partition count mismatch accepted')
 policy.write_text('[]');assert m.compare(root,1,policy)==1
 policy.write_text(json.dumps([entry]))
 reports['base'].write_text(json.dumps(dict(original,newReds=[],passed=[ident])))
 assert m.compare(root,1,policy)==1, 'committed quarantine cannot authorize a new hosted red'
 reports['base'].write_text(json.dumps(original))
 head=json.loads(reports['head'].read_text());reports['head'].write_text(json.dumps(dict(head,newReds=[],passed=[ident])))
 assert m.compare(root,1,policy)==1, 'recovered quarantine must be removed'
 reports['head'].unlink()
 assert m.compare(root,1,policy)!=0
 for status,xml in [(101,'<testsuites/>'),(100,'<testsuites/>'),(0,'<testsuites><error/></testsuites>')]:
  junit.write_text(xml)
  try: m.record(junit,status,1,1)
  except ValueError: pass
  else: raise AssertionError('runner crash accepted')
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("base compilation uses an untouched base worktree and only features and packages that exist there", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-hosted-source-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    mkdirSync(path.join(dir, "backend"));
    mkdirSync(path.join(dir, "scripts"));
    writeFileSync(path.join(dir, "backend/marker"), "base");
    writeFileSync(path.join(dir, "scripts/client-data-scan.py"), "# synthetic scanner fixture\n");
    git("add", ".");
    const commit = () => git("-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", "commit", "-qm", "test fixture");
    commit();
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(dir, ".client-data-allow"), "# trusted scanner policy\n");
    writeFileSync(path.join(dir, "backend/marker"), "head");
    git("add", ".");
    commit();
    const head = git("rev-parse", "HEAD");
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin/cargo"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({packages:[{name:'shared',features:{full:[]}}]}));\n`, { mode: 0o700 });
    const output = path.join(dir, "env");
    const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_ENV: output, CI_BASE_SHA: base, CI_HEAD_SHA: head, CI_RUST_BUILD: JSON.stringify({ crates: ["shared", "new"], features: "shared/full,shared/test-postgres,new/full" }) };
    const run = (source, extra = {}) => spawnSync(process.execPath, [new URL("./ci/hosted-source.mjs", import.meta.url).pathname], { cwd: dir, encoding: "utf8", env: { ...env, CI_HOSTED_SOURCE: source, ...extra } });
    assert.equal(run("head").status, 0);
    writeFileSync(output, "");
    const result = run("base");
    assert.equal(result.status, 0, result.stderr);
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.equal(readFileSync(path.join(values.CI_SOURCE_ROOT, ".client-data-allow"), "utf8"), "# trusted scanner policy\n");
    assert.equal(readFileSync(path.join(values.CI_SOURCE_ROOT, "backend/marker"), "utf8"), "base");
    assert.equal(readFileSync(path.join(dir, "backend/marker"), "utf8"), "head");
    assert.equal(values.CI_SOURCE_SHA, base);
    assert.deepEqual(JSON.parse(values.CI_RUST_BUILD), { crates: ["shared"], features: "shared/full" });
    assert.notEqual(run("unknown").status, 0);
    assert.notEqual(run("head", { CI_HEAD_SHA: base }).status, 0);
    assert.notEqual(run("base", { CI_BASE_SHA: "--bad-ref" }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hosted DB consumer refuses an archive from the other source before running tests", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-hosted-archive-"));
  try {
    for (const sub of ["backend", "scripts/ci", ".cache/ci"]) mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/config.json"), readFileSync("scripts/ci/config.json"));
    writeFileSync(path.join(dir, ".cache/ci/source.json"), JSON.stringify({ source: "head", sha: "a".repeat(40) }));
    const result = spawnSync(process.execPath, [new URL("./ci/rust-tests.mjs", import.meta.url).pathname, "db", "1"], { cwd: path.join(dir, "backend"), encoding: "utf8", env: { ...process.env, CI_HOSTED_SOURCE: "base", CI_SOURCE_SHA: "a".repeat(40), CI_RUST_BUILD: "{}" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive source does not match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a package absent from the base emits empty partition receipts and never builds the whole base workspace", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-hosted-empty-"));
  try {
    for (const sub of ["backend", "scripts/ci"]) mkdirSync(path.join(dir, sub), { recursive: true });
    for (const file of ["hosted-db.py", "test-results.py", "config.json"]) copyFileSync(`scripts/ci/${file}`, path.join(dir, "scripts/ci", file));
    const env = { ...process.env, CI_HOSTED_SOURCE: "base", CI_SOURCE_SHA: "a".repeat(40), CI_BASE_SHA: "a".repeat(40), CI_HEAD_SHA: "b".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", CI_RUST_BUILD: JSON.stringify({ crates: [] }) };
    const build = spawnSync(process.execPath, [new URL("./ci/rust-build.mjs", import.meta.url).pathname], { cwd: path.join(dir, "backend"), encoding: "utf8", env });
    assert.equal(build.status, 0, build.stderr);
    copyFileSync(path.join(dir, ".cache/ci/build/tests/source.json"), path.join(dir, ".cache/ci/source.json"));
    const run = (extra = {}) => spawnSync(process.execPath, [new URL("./ci/rust-tests.mjs", import.meta.url).pathname, "db", "1"], { cwd: path.join(dir, "backend"), encoding: "utf8", env: { ...env, ...extra } });
    assert.equal(run().status, 0);
    const receipt = JSON.parse(readFileSync(path.join(dir, "backend/target/nextest/ci/junit.baseline.json"), "utf8"));
    assert.equal(receipt.tests, 0);
    assert.equal(receipt.sha, env.CI_BASE_SHA);
    assert.equal(receipt.comparisonPending, true);
    assert.notEqual(run({ CI_HOSTED_SOURCE: "head" }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the privacy gate scans the selected base source for private terms before publication", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-hosted-privacy-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
    const term = "synthetic-unpublished-client-term";
    writeFileSync(path.join(dir, "fixture.txt"), term);
    assert.equal(spawnSync("git", ["-C", dir, "add", "."]).status, 0);
    const result = spawnSync(process.execPath, ["scripts/ci/privacy.mjs"], { encoding: "utf8", env: { ...process.env, CI_SCAN_SOURCE_ROOT: dir, CLIENT_DATA_TERMS: term } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /privacy: payload scan refused \(private client term\)/);
    assert.ok(!result.stderr.includes(term));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ci-ok requires fresh paired evidence even when every DB job reports success", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-hosted-gate-"));
  try {
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    for (const file of ["hosted-db.py", "test-results.py", "config.json"]) copyFileSync(`scripts/ci/${file}`, path.join(dir, "scripts/ci", file));
    writeFileSync(path.join(dir, "scripts/ci/baseline.json"), "[]");
    writeFileSync(path.join(dir, "scripts/git-base.mjs"), "console.log('');\n");
    const env = { ...process.env, CI_BASE_SHA: "a".repeat(40), CI_HEAD_SHA: "b".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", NEEDS: JSON.stringify({ plan: { result: "success", outputs: { db: "true", required: JSON.stringify({ "backend-db": true }) } }, "backend-db": { result: "success" } }) };
    const run = () => spawnSync(process.execPath, [new URL("./ci/gate.mjs", import.meta.url).pathname], { cwd: dir, encoding: "utf8", env });
    const missing = run();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stdout, /missing base\/head partition evidence/);
    const config = JSON.parse(readFileSync("scripts/ci/config.json", "utf8"));
    for (const source of ["base", "head"]) for (let partition = 1; partition <= config.nextestPartitions.db; partition++) {
      const target = path.join(dir, ".cache/ci/db-collected", `${source}-${partition}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "junit.baseline.json"), JSON.stringify({ source, partition, partitions: config.nextestPartitions.db, sha: env[source === "base" ? "CI_BASE_SHA" : "CI_HEAD_SHA"], baseSha: env.CI_BASE_SHA, headSha: env.CI_HEAD_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, newReds: [], passed: [] }));
    }
    const complete = run();
    assert.equal(complete.status, 0, complete.stderr + complete.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
