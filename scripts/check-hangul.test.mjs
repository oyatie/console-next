// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const allow = entries => write("scripts/copy-hangul-baseline.json", JSON.stringify({ allow: entries }));
  return { root, write, git, commit, run, allow };
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

const official = { name: "official-labels", path: "backend/migrations/labels.sql", pattern: "'[^'\\r\\n]*'", reason: "Official Korean labels.", source: "https://www.law.go.kr/" };

test("UI selectors cannot approve their own synthetic Korean literals", t => {
  for (const file of ["e2e/probe/new.spec.ts", "apps/web/src/new.test.tsx"]) {
    const f = fixture(t);
    f.write(file, `getByRole('button', { name: '${ko}' });`);
    f.allow([{ name: "synthetic-label", path: file, pattern: ".+", reason: "x" }]);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /UI.*exception/);
  }
});

test("new migration text cannot self-approve with a nonofficial source", t => {
  const f = fixture(t);
  f.write(official.path, `INSERT INTO notifications VALUES ('${ko}');`);
  f.allow([{ ...official, source: "https://example.com" }]);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /allow-listed.*source/);
});

test("a Git rename or copy cannot free debt by declaring a new exception", t => {
  for (const operation of ["rename", "copy"]) {
    const original = "backend/migrations/original.sql", moved = "backend/migrations/moved.sql";
    const text = Array.from({ length: 20 }, (_, i) => `INSERT INTO labels VALUES (${i}, '${ko}');`).join("\n");
    const f = fixture(t, { [original]: text });
    if (operation === "rename") f.git("mv", original, moved);
    else f.write(moved, text);
    f.write("backend/migrations/unrelated.sql", `INSERT INTO labels VALUES ('${ko}');`);
    f.allow([{ ...official, path: moved }]);
    f.commit();
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /migrations: now \d+, baseline 0; new debt/);
  }
});

test("renaming a UI spec cannot launder existing selector debt", t => {
  const original = "e2e/original.spec.ts", moved = "e2e/moved.spec.ts";
  const f = fixture(t, { [original]: `getByRole('button', { name: '${ko}' });\n`.repeat(4) });
  f.git("mv", original, moved);
  f.allow([{ name: "synthetic-selectors", path: moved, pattern: ".+", reason: "x" }]);
  f.write("e2e/unrelated.spec.ts", `// ${ko}\n// ${ko}`);
  f.commit();
  assert.equal(f.run().status, 1);
});

test("a renamed file retains its allowed-fragment ceiling", t => {
  const original = "backend/migrations/original.sql", moved = "backend/migrations/moved.sql";
  const text = Array.from({ length: 20 }, (_, i) => `INSERT INTO labels VALUES (${i}, '${ko}');`).join("\n");
  const f = fixture(t, { [original]: text });
  f.git("mv", original, moved);
  f.allow([{ ...official, path: moved }]);
  f.commit();
  assert.equal(f.run().status, 0, f.run().stderr);
  f.write(moved, `${text}\nINSERT INTO labels VALUES (20, '${ko}');`);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /allowed.official-labels: now 21, baseline 20; new debt/);
});

test("reclassification measures existing labels with the current rules and never permits growth", t => {
  const f = fixture(t, { [official.path]: `INSERT INTO labels VALUES ('${ko}');` });
  f.allow([official]);
  assert.equal(f.run().status, 0, f.run().stderr);
  f.write(official.path, `INSERT INTO labels VALUES ('${ko}');\nINSERT INTO labels VALUES ('${ko}');`);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /allowed.official-labels: now 2, baseline 1; new debt/);
});

test("binary filtering rejects invalid UTF-8 and NUL blobs at base and tip", t => {
  const f = fixture(t, {
    "fixtures/invalid.dat": Buffer.concat([Buffer.from([0xff]), Buffer.from(ko)]),
    "fixtures/nul.dat": Buffer.from(`\0${ko}`),
    "fixtures/text.dat": ko,
  });
  f.write("fixtures/invalid.dat", Buffer.concat([Buffer.from([0xfe]), Buffer.from(ko.repeat(2))]));
  f.write("fixtures/nul.dat", Buffer.from(`\0${ko}\n${ko}`));
  f.write("fixtures/new-invalid.dat", Buffer.concat([Buffer.from([0xff]), Buffer.from(ko)]));
  f.write("fixtures/new-nul.dat", Buffer.from(`\0${ko}`));
  const result = f.run("--report");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hangul lines: \{"other":1\}/);
  assert.match(result.stdout, /Merge-base Hangul lines: \{"other":1\}/);
});

test("every new or changed exception is visible in logs and the step summary even on refusal", t => {
  const f = fixture(t, { [official.path]: `INSERT INTO labels VALUES ('${ko}');` });
  const summary = path.join(f.root, "summary.md");
  const run = () => spawnSync(process.execPath, ["scripts/check-hangul.mjs"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, QUALITY_BASE: "origin/dev", GITHUB_STEP_SUMMARY: summary },
  });
  f.allow([official]);
  const added = run();
  assert.equal(added.status, 0, added.stderr);
  assert.ok(added.stdout.includes(JSON.stringify(official)));
  assert.ok(readFileSync(summary, "utf8").includes(JSON.stringify(official)));
  f.commit();
  f.git("update-ref", "refs/remotes/origin/dev", "HEAD");
  writeFileSync(summary, "");
  assert.equal(run().stdout, "");
  assert.equal(readFileSync(summary, "utf8"), "");
  const changed = { ...official, pattern: ".+", reason: "Changed exception." };
  const second = { ...official, name: "official-other", path: "backend/refdata/other.tsv", source: "https://example.com" };
  f.allow([changed, second]);
  const refused = run();
  assert.equal(refused.status, 1);
  for (const entry of [changed, second]) {
    assert.ok(refused.stdout.includes(JSON.stringify(entry)));
    assert.ok(readFileSync(summary, "utf8").includes(JSON.stringify(entry)));
  }
});
