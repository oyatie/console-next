// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

for (const kind of ["playwright", "nextest"]) {
  test(`${kind}: a recovered baseline test is red until removed; unrelated shards stay green`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "console-strict-reds-"));
    try {
      const entry = { kind, context: "context", suite: "suite", test: "fixed", owner: "Jason Lee", expires: "2099-01-01" };
      const policy = path.join(dir, "baseline.json"), junit = path.join(dir, "junit.xml");
      writeFileSync(policy, JSON.stringify([entry]));
      writeFileSync(junit, '<testsuites><testsuite tests="1" failures="0"><testcase classname="suite" name="fixed"/></testsuite></testsuites>');
      const run = (status = "0") => spawnSync("python3", ["scripts/ci/test-results.py", kind, "context", junit, status, policy], { encoding: "utf8" });
      assert.equal(run().status, 1);
      assert.match(run().stdout, /remove from baseline/);
      writeFileSync(policy, "[]");
      assert.equal(run().status, 0);
      assert.equal(run(kind === "nextest" ? "100" : "1").status, 1, "nonzero exit without failed cases");
      writeFileSync(policy, JSON.stringify([{ ...entry, test: "other shard" }]));
      assert.equal(run().status, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("baseline inventory refuses deleted tests and first-run quarantine", () => {
  const result = spawnSync("python3", ["-c", `import importlib.util
s=importlib.util.spec_from_file_location('results','scripts/ci/test-results.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
e={('nextest','db','crate::binary','missing')}
try: m.inventory('nextest','db',{'rust-suites':{}},e)
except ValueError: pass
else: raise AssertionError('missing baseline test accepted')
m.inventory('nextest','db',{'rust-suites':{'crate::binary':{'testcases':{'missing':{}}}}},e)
m.inventory('nextest','db',{'rust-suites':{}},set())
b={('playwright','chromium','missing.spec.ts','title')}
try: m.inventory('playwright','chromium',{'suites':[]},b)
except ValueError: pass
else: raise AssertionError('missing browser baseline test accepted')
m.inventory('playwright','chromium',{'suites':[{'file':'missing.spec.ts','specs':[{'title':'title'}]}]},b)
m.inventory('playwright','chromium',{'suites':[]},set())
m.inventory('nextest','unit',{'rust-suites':{}},e)
import tempfile,json
from pathlib import Path
with tempfile.TemporaryDirectory() as d:
 p=Path(d)/'baseline.json';p.write_text(json.dumps([{'kind':'playwright','context':'chromium','suite':'first-run-solo.spec.ts','test':'gate','owner':'Jason Lee','expires':'2099-01-01'}]))
 try: m.baseline(p)
 except ValueError: pass
 else: raise AssertionError('first-run quarantine accepted')
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const entries = JSON.parse(readFileSync(new URL("./ci/baseline.json", import.meta.url), "utf8"));
  assert.ok(!entries.some((e) => /first-run-solo|register-run|import\/two-entities/.test(e.suite)));
});

test("the build disk-budget step is mandatory before artifact publication", () => {
  const wf = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const steps = wf.jobs["rust-build"].steps;
  const i = steps.findIndex((s) => s.run === "python3 scripts/ci/disk-budget.py");
  assert.ok(i >= 0);
  assert.equal(steps[i].if, undefined);
  assert.ok(!steps[i]["continue-on-error"]);
  assert.ok(i < steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact")));
});

test("archive extraction checks expanded bytes and free-space margin before nextest", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-extraction-disk-"));
  try {
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    mkdirSync(path.join(dir, ".cache/ci"), { recursive: true });
    copyFileSync(new URL("./ci/disk-budget.py", import.meta.url), path.join(dir, "scripts/ci/disk-budget.py"));
    writeFileSync(path.join(dir, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const create = spawnSync("python3", ["-c", `import io,sys,tarfile,subprocess
from pathlib import Path
p=Path(sys.argv[1])/'.cache/ci/workspace.tar'
with tarfile.open(p,'w') as t:
 i=tarfile.TarInfo('test');i.size=1024;t.addfile(i,io.BytesIO(b'x'*1024))
subprocess.run(['zstd','-q',str(p)],check=True)
`, dir], { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);
    const run = (bytes, margin) => {
      writeFileSync(path.join(dir, "scripts/ci/config.json"), JSON.stringify({ runnerDiskBudgetBytes: bytes, runnerDiskMarginBytes: margin }));
      return spawnSync("python3", ["scripts/ci/disk-budget.py", "--test"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    };
    assert.equal(run(2048, 0).status, 0);
    assert.equal(run(100, 0).status, 1);
    assert.equal(run(2048, Number.MAX_SAFE_INTEGER).status, 1);
    const runner = readFileSync(new URL("./ci/rust-tests.mjs", import.meta.url), "utf8");
    assert.match(runner, /disk-budget\.py", "--test"/);
    assert.ok(runner.indexOf('disk.status !== 0') < runner.indexOf('["nextest", "run"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
