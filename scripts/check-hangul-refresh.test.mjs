// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, ko } from "./test-fixtures/hangul.mjs";

const official = { name: "official-labels", path: "backend/refdata/labels.tsv", pattern: '"[^"\\r\\n]*"', reason: "Official Korean labels.", source: "https://www.law.go.kr/" };
const baselineFile = "scripts/copy-hangul-baseline.json";

for (const added of [false, true]) {
  test(`relocating an excepted line within its category permits only relocation: added=${added}`, t => {
    const entry = { name: "synthetic-input", path: "packages/i18n/src/input.test.ts", pattern: '"[^"\\r\\n]*"', reason: "Korean input." };
    const lines = [0, 1].map(i => `test("${ko} ${i}"); // ${ko}`);
    const f = fixture(t, { [entry.path]: lines.join("\n"), [baselineFile]: JSON.stringify({ allow: [entry] }) });
    f.write(entry.path, [lines[1], ...(added ? [`test("${ko} new");`] : [])].join("\n"));
    f.write("packages/i18n/src/input-notes.test.ts", lines[0]);
    const result = f.run();
    assert.equal(result.status, added ? 1 : 0, result.stderr || result.stdout);
    if (added) {
      assert.match(result.stderr, /other: 3 Hangul lines, merge base 2; a category cannot add Hangul lines/);
      assert.doesNotMatch(result.stderr, /new debt|a file with a test exception/);
      assert.equal(result.stdout, "");
    }
  });
}

test("an existing test exception cannot trade double-counted fragments for new lines", t => {
  const entry = { name: "synthetic-input", path: "packages/i18n/src/input.test.ts", pattern: '"[^"\\r\\n]*"', reason: "Korean input." };
  const lines = Array.from({ length: 5 }, (_, i) => `test("${ko} ${i}"); // ${ko}`);
  const f = fixture(t, { [entry.path]: lines.join("\n"), [baselineFile]: JSON.stringify({ allow: [entry] }) });
  f.write(entry.path, [...lines.map(line => line.replace(ko, "English")), ...lines.map((_, i) => `test("${ko} added ${i}");`)].join("\n"));
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /10 Hangul lines, merge base 5; a file with a test exception cannot add Hangul lines/);
});

for (const operation of ["in place", "rename"]) {
  test(`a new test exception cannot trade two-string fragments for new lines: ${operation}`, t => {
    const results = [];
    for (const existing of operation === "rename" ? [false, true] : [false]) {
      const original = "backend/tests/input_tests.rs", target = operation === "rename" ? "backend/tests/moved_tests.rs" : original;
      const entry = { name: "synthetic-input", path: original, pattern: '"[^"\\r\\n]*"', reason: "Korean input." };
      const lines = Array.from({ length: 7 }, (_, i) => `assert_eq!(normalize_${i}("${ko}"), "${ko}");`);
      const padding = Array.from({ length: 60 }, (_, i) => `assert_eq!(normalize_${i}("English input"), "English output");`);
      const f = fixture(t, { [original]: [...lines, ...padding].join("\n") + "\n", [baselineFile]: JSON.stringify({ allow: existing ? [entry] : [] }) });
      if (operation === "rename") f.git("mv", original, target);
      f.write(target, [
        ...lines.map(line => line.replace(`, "${ko}"`, ', "English"')),
        ...padding,
        ...lines.map((_, i) => `assert_eq!(error_${i}, E("${ko}"));`),
      ].join("\n"));
      f.allow([{ ...entry, name: "synthetic-added", path: target, pattern: '(?<=, )"[^"\\r\\n]*"|(?<=E\\()"[^"\\r\\n]*"' }]);
      f.git("add", ".");
      if (operation === "rename") assert.match(f.git("diff", "--name-status", "-M", "HEAD"), /R\d+\s+backend\/tests\/input_tests.rs\s+backend\/tests\/moved_tests.rs/);
      results.push(f.run());
    }
    for (const result of results) {
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /14 Hangul lines, merge base 7; a file with a test exception cannot add Hangul lines/);
    }
  });
}

test("translating a comment on an excepted line remains a permitted reduction", t => {
  const entry = { name: "synthetic-input", path: "packages/i18n/src/input.test.ts", pattern: '"[^"\\r\\n]*"', reason: "Korean input." };
  const f = fixture(t, { [entry.path]: `test("${ko}"); // ${ko}`, [baselineFile]: JSON.stringify({ allow: [entry] }) });
  f.write(entry.path, `test("${ko}"); // English comment`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const [covered, name] of [[true, "synthetic-a-copy"], [true, "synthetic-z-copy"], [false, "synthetic-a-copy"]]) {
  test(`different-pattern copy cannot claim two-string source lines: covered=${covered}, ${name}`, t => {
    const entry = { ...official, name: "synthetic-names", path: "backend/tests/names_tests.rs", source: undefined };
    const copy = "backend/tests/names_copy_tests.rs";
    const count = covered ? 8 : 7;
    const lines = [
      ...Array.from({ length: count }, (_, i) => `assert_eq!(normalize_${i}("${ko}"), "${ko}");`),
      ...Array.from({ length: 60 }, (_, i) => `assert_eq!(normalize_${i}("English input"), "English output");`),
    ];
    const f = fixture(t, { [entry.path]: lines.join("\n") + "\n", [baselineFile]: JSON.stringify({ allow: covered ? [entry] : [] }) });
    f.write(copy, [
      ...lines.map(line => line.replaceAll(ko, "xx")),
      ...Array.from({ length: count }, (_, i) => `assert_eq!(error_${i}, E("${ko}"));`),
    ].join("\n"));
    const pattern = '(?<=E\\()"[^"\\r\\n]*"|(?<=\\p{Script=Hangul}[^\\r\\n]*)"[^"\\r\\n]*\\p{Script=Hangul}[^"\\r\\n]*"';
    f.allow([...(covered ? [entry] : []), { ...entry, name, path: copy, pattern }].sort((a, b) => a.name.localeCompare(b.name)));
    f.git("add", ".");
    assert.match(f.git("diff", "--name-status", "-C", "--find-copies-harder", "HEAD"), /C\d+\s+backend\/tests\/names_tests.rs\s+backend\/tests\/names_copy_tests.rs/);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /new test exceptions cannot self-approve/);
  });
}

for (const name of ["synthetic-a-copy", "synthetic-z-copy"]) {
  test(`Git-detected synthetic copy cannot inherit headroom: ${name}`, t => {
    const entry = { ...official, name: "synthetic-names", path: "backend/tests/names_tests.rs", source: undefined };
    const copy = "backend/tests/names_copy_tests.rs";
    const lines = Array.from({ length: 43 }, (_, i) => `const NAME_${i}: &str = "${ko}";`);
    const f = fixture(t, { [entry.path]: lines.join("\n") + "\n", [baselineFile]: JSON.stringify({ allow: [entry] }) });
    f.write(copy, lines.map((line, i) => i < 12 ? `assert_eq!(error_${i}, "${ko}");` : line).join("\n"));
    f.allow([entry, { ...entry, name, path: copy }].sort((a, b) => a.name.localeCompare(b.name)));
    f.git("add", ".");
    assert.match(f.git("diff", "--name-status", "-C", "--find-copies-harder", "HEAD"), /C\d+\s+backend\/tests\/names_tests.rs\s+backend\/tests\/names_copy_tests.rs/);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /new test exceptions cannot self-approve|baseline 0; new debt/);
  });
}

for (const [file, existing] of [["backend/crates/refdata/lists/src/lib.rs", true], ["backend/crates/hr/app/src/refdata/messages.rs", false]]) {
  test(`official data exceptions cannot cover Rust code: ${file}`, t => {
    const text = `pub const LABEL: &str = "${ko}";\n`;
    const entry = { ...official, path: file };
    const f = fixture(t, existing ? { [file]: text } : {});
    f.write(file, `${existing ? text + "\n" : ""}${Array.from({ length: 20 }, (_, i) => `pub const ERROR_${i}: &str = "${ko}";`).join("\n")}`);
    f.allow([entry]);
    f.git("add", ".");
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /eligible path|new debt|cannot self-approve/);
  });
}

for (const [name, file] of [
  ["synthetic-labels", "backend/refdata/labels.tsv"],
  ["official-labels", "backend/tests/labels_tests.rs"],
  ["official-labels", "backend/refdata/labels_tests.sql"],
]) {
  test(`existing exception growth requires every refresh guard: ${name} in ${file}`, t => {
    const entry = { ...official, name, path: file };
    const text = `const LABEL: &str = "${ko}";\n`;
    const f = fixture(t, { [file]: text, [baselineFile]: JSON.stringify({ allow: [entry] }) });
    assert.equal(f.run().status, 0, f.run().stderr);
    f.write(file, `${text}\n${text}`);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`allowed.${name}: now 2, baseline 1; new debt`));
  });
}

test("an official publisher suffix without a subdomain boundary is refused", t => {
  const f = fixture(t);
  f.write(official.path, `LABEL = "${ko}";`);
  f.allow([{ ...official, source: "https://evillaw.go.kr/labels" }]);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /allow-listed.*source/);
});

for (const extension of ["css", "scss"]) {
  test(`CSS hexadecimal escapes remain product debt in ${extension}`, t => {
    const file = `apps/web/src/input.${extension}`;
    const raw = [...ko].map(char => char.codePointAt(0).toString(16));
    const spellings = [
      raw.map(hex => "\\" + hex.toUpperCase()).join(""),
      raw.map(hex => "\\" + hex.padStart(6, "0")).join(""),
      raw.map(hex => "\\" + hex + " ").join(""),
      raw.map(hex => "\\" + hex + "\n").join(""),
    ];
    const f = fixture(t, { [file]: ".existing { color: inherit; }", "fixtures/input.txt": `${ko}\n${ko}` });
    f.write("fixtures/input.txt", "");
    for (const escaped of spellings) {
      // Remove category debt to prove the product rule independently of the ratchet.
      f.write(file, `.probe::after { content: "${escaped}"; }`);
      const result = f.run();
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, new RegExp(`input.${extension}:1: literal outside`));
      assert.doesNotMatch(result.stderr, /other:.*new debt/);
    }
  });
}
