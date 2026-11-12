// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ko = "\uD55C\uAE00";
function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "hangul-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  for (const file of ["check-hangul.mjs", "quality/base.mjs"]) {
    mkdirSync(path.dirname(path.join(root, "scripts", file)), { recursive: true });
    copyFileSync(fileURLToPath(new URL(file, import.meta.url)), path.join(root, "scripts", file));
  }
  write("scripts/copy-hangul-baseline.json", '{"allow":[]}');
  for (const [file, text] of Object.entries(files)) write(file, text);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = () => { git("add", "."); git("commit", "-qm", "test: copy fixture"); };
  git("init", "-qb", "dev");
  commit();
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  git("checkout", "-qb", "candidate");
  const run = (...args) => spawnSync(process.execPath, ["scripts/check-hangul.mjs", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, QUALITY_BASE: "origin/dev" } });
  return { write, git, commit, run };
}

test("Node-only gate accepts reductions, reports counts, and refuses category growth", t => {
  const f = fixture(t, { "e2e/example.spec.ts": `// ${ko}\n// ${ko}` });
  assert.equal(f.run().status, 0);
  f.write("e2e/example.spec.ts", `// ${ko}`);
  assert.equal(f.run().status, 0);
  const report = f.run("--report");
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /"e2e":1/);
  assert.match(report.stdout, /"e2e":2/);
  f.write("backend/app/src/main.rs", `// ${ko}`);
  assert.match(f.run().stderr, /rustSource: now 1, baseline 0; new debt/);
  assert.equal(f.run().status, 1);
});

test("ceiling uses the merge base, not later debt added on the target branch", t => {
  const f = fixture(t);
  f.git("checkout", "dev");
  f.write("e2e/later.spec.ts", `// ${ko}`);
  f.commit();
  f.git("update-ref", "refs/remotes/origin/dev", "HEAD");
  f.git("checkout", "candidate");
  f.write("e2e/candidate.spec.ts", `// ${ko}`);
  f.commit();
  assert.equal(f.run().status, 1);
  assert.match(f.run().stderr, /e2e: now 1, baseline 0/);
});

test("planted literal in shipped spec cannot hide behind removed test debt", t => {
  const file = "apps/web/src/features/entity/ui/name-correction-spec.tsx";
  const f = fixture(t, { [file]: "export {};", "apps/web/src/example.test.tsx": `// ${ko}` });
  f.write(file, `export const plantedLabel = "${ko}";`);
  f.write("apps/web/src/example.test.tsx", "");
  assert.equal(f.run().status, 1);
  assert.match(f.run().stderr, /name-correction-spec.tsx:1: literal outside/);
});

test("new official residence-status data requires a source; comments remain debt", t => {
  const f = fixture(t);
  const entry = { name: "official-residence-status", path: "backend/crates/platform/db/migrations/20261112141303000_residence_status_catalog.sql", pattern: "'[^'\\n]*'", reason: "Official Korean residence-status labels.", source: "https://www.law.go.kr/" };
  f.write(entry.path, `INSERT INTO labels VALUES ('${ko}');`);
  const allow = entries => f.write("scripts/copy-hangul-baseline.json", JSON.stringify({ allow: entries }));
  allow([entry]);
  assert.equal(f.run().status, 0, f.run().stderr);
  allow([{ ...entry, source: undefined }]);
  assert.equal(f.run().status, 1);
  assert.match(f.run().stderr, /source/);
  allow([entry]);
  f.write(entry.path, `INSERT INTO labels VALUES ('${ko}'); -- ${ko}`);
  assert.match(f.run().stderr, /migrations: now 1, baseline 0/);
});

test("invalid merge bases fail closed", t => {
  const f = fixture(t);
  f.git("update-ref", "-d", "refs/remotes/origin/dev");
  assert.equal(f.run().status, 1);
  assert.match(f.run().stderr, /cannot resolve quality merge-base/);
});
