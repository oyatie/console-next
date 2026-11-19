// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { hangulDebt } from "./check-hangul.mjs";
import { fixture, ko } from "./test-fixtures/hangul.mjs";


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

test("a renamed official file can refresh its sourced labels", t => {
  const original = "backend/migrations/original.sql", moved = "backend/migrations/moved.sql";
  const text = Array.from({ length: 20 }, (_, i) => `INSERT INTO labels VALUES (${i}, '${ko}');`).join("\n");
  const f = fixture(t, { [original]: text });
  f.git("mv", original, moved);
  f.allow([{ ...official, path: moved }]);
  f.commit();
  assert.equal(f.run().status, 0, f.run().stderr);
  f.write(moved, `${text}\nINSERT INTO labels VALUES (20, '${ko}');`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test("reclassification permits sourced official label refreshes", t => {
  const f = fixture(t, { [official.path]: `INSERT INTO labels VALUES ('${ko}');` });
  f.allow([official]);
  assert.equal(f.run().status, 0, f.run().stderr);
  f.write(official.path, `INSERT INTO labels VALUES ('${ko}');\nINSERT INTO labels VALUES ('${ko}');`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
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
  assert.match(result.stdout, /Hangul lines: \{"other":1,"scripts":1\}/);
  assert.match(result.stdout, /Merge-base Hangul lines: \{"other":1,"scripts":1\}/);
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

// Build encoded probes so the test source does not add the debt it is testing.
const points = [...ko].map(char => char.codePointAt(0));
const escaped = [
  points.map(point => "\\u" + point.toString(16)).join(""),
  points.map(point => "\\u{" + point.toString(16) + "}").join(""),
  points.map(point => "&#x" + point.toString(16) + ";").join(""),
  points.map(point => "&#" + point + ";").join(""),
  `String.fromCharCode(${points.join(", ")})`,
  `String.fromCharCode(${points.map(point => "0x" + point.toString(16)).join(", ")})`,
  `String.fromCodePoint(${points.join(", ")})`,
  `String.fromCharCode(...[${points.join(", ")}])`,
  `String.fromCodePoint(...[${points.join(", ")}])`,
  `String.fromCharCode(...[${points.join(", ")},])`,
  ...[2, 8].map(radix => `String.fromCharCode(${points.map(point => (radix === 2 ? "0b" : "0o") + point.toString(radix)).join(",")})`),
  `String.fromCharCode(${points.map(point => point - 65536).join(",")})`,
  `String.fromCharCode(${points.map(point => `${point}.5`).join(",")})`,
  `String.fromCharCode(${points.map(point => `${point / 10}e1`).join(",")})`,
  `String.fromCodePoint(${points.map(point => "+0x" + point.toString(16)).join(",")})`,
];

test("encoded selectors are debt without an exception", t => {
  const f = fixture(t);
  for (const text of escaped) {
    f.write("e2e/encoded.spec.ts", `getByRole('button', { name: '${text}' });`);
    const result = f.run();
    assert.equal(result.status, 1, text);
    assert.match(result.stderr, /e2e: now 1, baseline 0/);
  }
});

test("new synthetic and official test exceptions have no self-declared headroom", t => {
  const f = fixture(t);
  const file = "backend/tests/assertions.rs";
  f.write(file, `assert_eq!(error, "${ko}");\n`.repeat(30));
  for (const name of ["synthetic-assertions", "official-assertions"]) {
    f.allow([{ ...official, name, path: file, pattern: '\"[^\"\\r\\n]*\"' }]);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /new test exceptions cannot self-approve/);
  }
});

test("existing synthetic exceptions keep their ceiling in new test files", t => {
  const file = "backend/tests/names.rs", copy = "backend/tests/copy.rs";
  const entry = { name: "synthetic-names", path: file, pattern: '\"[^\"\\r\\n]*\"', reason: "Korean name input." };
  const f = fixture(t, { [file]: `const NAME: &str = "${ko}";\n`, "rustfmt.toml": 'edition = "2024"\n', "scripts/copy-hangul-baseline.json": JSON.stringify({ allow: [entry] }) });
  f.write(copy, `let name = "${ko}";\n`.repeat(30));
  f.allow([entry, { ...entry, name: "synthetic-other", path: copy }]);
  assert.equal(f.run().status, 1);
  f.write(file, `let name = "${ko}";\n`.repeat(2));
  f.allow([entry]);
  assert.match(f.run().stderr, /allowed.synthetic-names: now 2, baseline 1/);
});

test("official reference refreshes allow additions, renames and copies without blessing comments", t => {
  for (const operation of ["append", "rename", "copy"]) {
    const file = "backend/refdata/labels.tsv", next = "backend/refdata/next.tsv";
    const entry = { ...official, path: file, pattern: "(?<=\\t)[^\\t\\r\\n]+" };
    const text = Array.from({ length: 20 }, (_, i) => `${i}\t${ko}`).join("\n");
    const f = fixture(t, { [file]: text, "scripts/copy-hangul-baseline.json": JSON.stringify({ allow: [entry] }) });
    const target = operation === "append" ? file : next;
    if (operation === "rename") f.git("mv", file, target);
    f.write(target, `${text}\n20\t${ko}`);
    if (operation === "rename") f.allow([{ ...entry, path: target }]);
    if (operation === "copy") f.allow([{ ...entry, name: "official-copy", path: target }, entry]);
    f.git("add", ".");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Hangul exception count changes:/);
    if (operation === "copy") {
      assert.match(result.stdout, /allowed.official-copy: 20 -> 21/);
      assert.doesNotMatch(result.stdout, /allowed.official-labels: 0 -> 20/);
    }
    f.write(target, `${text}\n20\t${ko}\n# ${ko}`);
    assert.match(f.run().stderr, /other: now 1, baseline 0/);
  }
});

test("hash comments and bare matches remain debt", t => {
  const f = fixture(t);
  const file = "scripts/input_test.py";
  f.write(file, `# "${ko}"`);
  f.allow([{ name: "synthetic-input", path: file, pattern: '\"[^\"\\r\\n]*\"', reason: "Korean input." }]);
  assert.match(f.run().stderr, /scripts: now 2, baseline 1/);
});

test("pre-existing escaped product text is baselined but new escaped product text is refused", t => {
  const file = "apps/web/src/input.ts";
  const f = fixture(t, { [file]: `const input = "${escaped[0]}";` });
  assert.equal(f.run().status, 0, f.run().stderr);
  f.write(file, `// English comment\nconst input = "${escaped[0]}";`);
  assert.equal(f.run().status, 0, f.run().stderr);
  f.write(file, `// English comment\nconst input = "${escaped[0]}";\nconst added = "${escaped[1]}";`);
  assert.match(f.run().stderr, /input.ts:3: literal outside/);
  f.write(file, `const input = "${ko}";`);
  assert.match(f.run().stderr, /input.ts:1: literal outside/);
});

test("multiline static selector constructors are counted on their original lines", t => {
  const f = fixture(t);
  f.write("e2e/encoded.spec.ts", `getByRole('button', { name: String.fromCharCode(\n${points.join(",\n")}\n) });`);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /e2e: now 2, baseline 0/);
});

test("the declared import dictionary owns header synonyms without exempting other text or fixtures", () => {
  const file = "backend/crates/hr/domain/data/employee.json";
  const catalogue = { object: "employee", fields: [{ target: "name", aliases: [ko], label_ids: { ko: "import.target.name", en: "import.target.name" } }] };
  const check = (file, data) => hangulDebt([{ file, text: JSON.stringify(data) }], []);
  assert.deepEqual(check(file, catalogue).counts, {});
  assert.equal(check("backend/crates/hr/domain/tests/fixtures/input.json", catalogue).counts.other, 1);
  assert.equal(check(file, { ...catalogue, note: ko }).counts.other, 1);
  assert.throws(() => check(file, { fields: [{ aliases: [123] }] }), /aliases must be strings/);
});

test("the shared synthetic mock tenant JSON is pure data while any other e2e JSON or TS file remains checked", () => {
  const file = "e2e/mock/saeon-universe.json";
  assert.deepEqual(hangulDebt([{ file, text: JSON.stringify({ tenantName: ko }) }], []).counts, {});
  assert.equal(hangulDebt([{ file: "e2e/mock/other.json", text: JSON.stringify({ tenantName: ko }) }], []).counts.e2e, 1);
  assert.equal(hangulDebt([{ file: "e2e/mock/saeon.ts", text: `export const label = "${ko}";` }], []).counts.e2e, 1);
  assert.throws(() => hangulDebt([{ file, text: "[]" }], []), /JSON object/);
});
