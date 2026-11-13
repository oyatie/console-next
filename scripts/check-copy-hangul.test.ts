// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { hangulDebt, checkHangulBaseline } from "./check-hangul.mjs";

import { koCommon } from "../packages/i18n/src/catalogs/ko/common.ts";

const ko = koCommon["common.closeRelated"].slice(0, 2);
const allow = [{ name: "import-names", path: "backend/tests/names.rs", pattern: '"[^"\\n]*"', reason: "Synthetic Korean name normalization input." }];
const measure = (file: string, text = `// ${ko}`) => hangulDebt([{ file, text }], []).counts;

test.each([
  ["backend/app/src/main.rs", "rustSource"],
  ["backend/app/src/names_tests.rs", "rustTests"],
  ["backend/app/tests/names/nested.rs", "rustTests"],
  ["e2e/mock/names.spec.ts", "e2e"],
  ["apps/web/src/example.test.tsx", "webTests"],
  ["scripts/example.sh", "scripts"],
  ["backend/crates/platform/db/migrations/example.sql", "migrations"],
  ["docs/design/example.md", "docs"],
  ["README.md", "docs"],
  ["packages/i18n/src/josa.ts", "other"],
])("counts Hangul lines in %s", (file, category) => {
  expect(measure(file, `English\n// ${ko} ${ko}\n// ${ko}\n`)).toEqual({ [category]: 2 });
});

test("catalogs and generated API declarations retain their existing exemption; catalog tests do not", () => {
  for (const file of ["packages/i18n/src/catalogs/ko/a.ts", "packages/i18n/src/catalogs/boot.ts", "packages/i18n/src/catalogs/labels.json", "packages/api/src/schema.d.ts"]) expect(measure(file)).toEqual({});
  expect(measure("packages/i18n/src/catalogs/copy.test.ts")).toEqual({ other: 1 });
  expect(measure("packages/i18n/src/catalogs/README.md")).toEqual({ docs: 1 });
});

test("Hangul Jamo is covered and product source remains a zero-debt gate", () => {
  expect(measure("scripts/jamo.py", ko.normalize("NFD").at(0))).toEqual({ scripts: 1 });
  for (const file of ["apps/web/src/example.tsx", "packages/api/src/example.ts"]) {
    const result = hangulDebt([{ file, text: ko }], []);
    expect(result.problems.join("\n")).toContain(`${file}:1: literal outside`);
  }
});

test("named synthetic inputs are counted separately; comments and other paths remain debt", () => {
  const rows = [{ file: allow[0]!.path, text: `let name = "${ko}"; // ${ko}\n// ${ko}\nlet other = "${ko}";` }];
  expect(hangulDebt(rows, allow).counts).toEqual({ "allowed.import-names": 2, rustTests: 2 });
  expect(hangulDebt([{ ...rows[0]!, file: "backend/tests/other.rs" }], allow).counts).toEqual({ rustTests: 3 });
});

test("quoted Korean in line comments and nested block comments is never an input exception", () => {
  const file = allow[0]!.path;
  const text = [`let name = "${ko}"; // "${ko}"`, `/*`, `"${ko}"`, `/* "${ko}" */`, `"${ko}"`, `*/`, `let name = "${ko}";`].join("\n");
  expect(hangulDebt([{ file, text }], allow).counts).toEqual({ "allowed.import-names": 2, rustTests: 4 });
});

test.each([
  { ...allow[0], reason: "" },
  { ...allow[0], path: "backend/src/main.rs" },
  { ...allow[0], pattern: "[" },
])("invalid allow-list entries fail closed: %j", (entry) => {
  expect(() => hangulDebt([], [entry])).toThrow(entry.pattern === "[" ? /Invalid regular expression/ : /Hangul exception/);
});

test("each category refuses growth and accepts reductions without stored counts", () => {
  for (const category of ["rustSource", "rustTests", "e2e", "webTests", "scripts", "migrations", "docs", "other", "allowed.import-names"]) {
    const baseline = { [category]: 1 };
    expect(checkHangulBaseline({ [category]: 1 }, baseline)).toEqual([]);
    expect(checkHangulBaseline({ [category]: 2 }, baseline).join("\n")).toContain("new debt");
    expect(checkHangulBaseline({}, baseline)).toEqual([]);
  }
  expect(checkHangulBaseline({ rustSource: 2 }, { rustSource: 1, e2e: 1 }).join("\n")).toContain("rustSource: now 2");
});

test("a widened exception cannot bless growth; removing exceptions is allowed", () => {
  expect(checkHangulBaseline({ "allowed.import-names": 1 }, {}, [{ ...allow[0], pattern: ".*" }], allow).join("\n")).toContain("existing exception cannot change");
  expect(checkHangulBaseline({ "allowed.renamed": 1 }, {}, [{ ...allow[0], name: "renamed", pattern: ".*" }], allow).join("\n")).toContain("existing exception cannot change");
  expect(checkHangulBaseline({}, {}, [], allow)).toEqual([]);
});

test("negative, fractional, and nonnumeric measured baseline values fail", () => {
  for (const count of [-1, 1.5, "1"]) {
    expect(checkHangulBaseline({ scripts: 1 }, { scripts: count })).not.toEqual([]);
  }
});

test("exception names are unique and unused exceptions must be removed", () => {
  expect(() => hangulDebt([], [allow[0], allow[0]])).toThrow(/Hangul exception/);
  expect(checkHangulBaseline({}, {}, allow).join("\n")).toContain("remove stale Hangul exception");
});

test.each(["name-correction-spec.tsx", "record-spec.ts", "browser-test.ts"])("shipped %s stays subject to zero Hangul even when test debt falls", file => {
  const result = hangulDebt([{ file: `apps/web/src/${file}`, text: `export const plantedLabel = "${ko}";` }], []);
  expect(result.problems.join("\n")).toContain("literal outside the i18n catalogs");
});

const official = { name: "official-residence-status", path: "backend/crates/platform/db/migrations/residence_status.sql", pattern: "'[^'\\n]*'", reason: "Official Korean residence-status labels.", source: "https://www.law.go.kr/" };

test("a sourced official addition in a new file passes while an unsourced addition fails", () => {
  const counts = hangulDebt([{ file: official.path, text: `INSERT INTO labels VALUES ('${ko}');` }], [official]).counts;
  expect(checkHangulBaseline(counts, {}, [official], [], undefined)).toEqual([]);
  expect(() => hangulDebt([], [{ ...official, source: undefined }])).toThrow(/source/);
});

test("official sources must be URLs and the exception list stays sorted", () => {
  for (const source of ["", "a statute", "file:///statute", "javascript:statute"]) expect(() => hangulDebt([], [{ ...official, source }])).toThrow(/source/);
  expect(() => hangulDebt([], [official, allow[0]])).toThrow(/sorted/);
});

test("sourced official labels may grow while other categories keep their ceiling", () => {
  const key = `allowed.${official.name}`;
  expect(checkHangulBaseline({ [key]: 3 }, { [key]: 3 }, [official], [])).toEqual([]);
  expect(checkHangulBaseline({ [key]: 4 }, { [key]: 3 }, [official], [])).toEqual([]);
});

test("non-Hangul exception matches never increment allowed counts", () => {
  expect(hangulDebt([{ file: allow[0]!.path, text: `let name = "English"; // ${ko}` }], allow).counts).toEqual({ rustTests: 1 });
});

test("path eligibility refuses product code even with a valid official source", () => {
  expect(() => hangulDebt([], [{ ...official, path: "backend/src/main.rs" }])).toThrow(/eligible path/);
});

test("official test entries need an allow-listed source even outside migrations", () => {
  expect(() => hangulDebt([], [{ ...official, path: "backend/tests/labels.rs", source: undefined }])).toThrow(/source/);
});

test.each(["e2e/example.spec.ts", "apps/web/src/example.test.tsx"])("UI exceptions are refused in %s", file => {
  expect(() => hangulDebt([], [{ ...allow[0], path: file }])).toThrow(/UI.*exception/);
});

test.each([".+", ".*", "^.*$", "[\\s\\S]+", "[^\\n]+", "(?:.){1,}", "(?:.+?)", "^.+$|unused"])("whole-line exception pattern %s is refused", pattern => {
  expect(() => hangulDebt([], [{ ...official, pattern }])).toThrow(/whole.line/);
});

test("a data-specific pattern cannot consume a complete line at runtime", () => {
  expect(hangulDebt([{ file: official.path, text: `INSERT '${ko}';` }], [{ ...official, pattern: "INSERT [^\\n]+" }]).counts).toEqual({ migrations: 1 });
});

test.each(["backend/migrations/labels_tests.sql", "backend/refdata/labels.test.ts"])("official data requires a source regardless of test naming: %s", file => {
  expect(() => hangulDebt([], [{ ...allow[0], path: file }])).toThrow(/source/);
});

test.each(["https://example.com", "https://law.go.kr.example.com", "https://example.com/law.go.kr", "https://law.go.kr@example.com", "https://github.com/other/repo", "https://github.com/unicode-org/cldr-json-fake"])("nonofficial source %s is refused", source => {
  expect(() => hangulDebt([], [{ ...official, source }])).toThrow(/allow-listed.*source/);
});

test.each(["law.go.kr", "nts.go.kr", "nps.or.kr", "nhis.or.kr", "comwel.or.kr", "ei.go.kr", "kosis.kr", "juso.go.kr", "code.go.kr"])("official publisher %s is accepted", host => {
  expect(() => hangulDebt([], [{ ...official, source: `https://www.${host}/labels` }])).not.toThrow();
});

const points = [...ko].map(char => char.codePointAt(0)!);
const encodings = [
  [...ko].map(char => "\\u" + char.codePointAt(0)!.toString(16)).join(""),
  [...ko].map(char => "\\u{" + char.codePointAt(0)!.toString(16) + "}").join(""),
  [...ko].map(char => "&#x" + char.codePointAt(0)!.toString(16) + ";").join(""),
  `String.fromCharCode(${[...ko].map(char => char.codePointAt(0)).join(",")})`,
  `String.fromCharCode(...[${[...ko].map(char => char.codePointAt(0)).join(",")}])`,
  `String.fromCodePoint(...[${[...ko].map(char => char.codePointAt(0)).join(",")}])`,
  `String.fromCharCode(...[${[...ko].map(char => char.codePointAt(0)).join(",")},])`,
  ...[2, 8].map(radix => `String.fromCharCode(${points.map(point => (radix === 2 ? "0b" : "0o") + point.toString(radix)).join(",")})`),
  `String.fromCharCode(${points.map(point => point - 65536).join(",")})`,
  `String.fromCharCode(${points.map(point => `${point}.5`).join(",")})`,
  `String.fromCharCode(${points.map(point => `${point / 10}e1`).join(",")})`,
  `String.fromCodePoint(${points.map(point => "+0x" + point.toString(16)).join(",")})`,
];
test.each([
  ["backend/src/main.rs", "rustSource"], ["backend/tests/input.rs", "rustTests"],
  ["e2e/example.spec.ts", "e2e"], ["apps/web/src/example.test.ts", "webTests"],
  ["scripts/input.py", "scripts"], ["backend/migrations/input.sql", "migrations"],
  ["docs/input.md", "docs"], ["fixtures/input.txt", "other"],
])("encoded Hangul is counted in %s", (file, category) => {
  for (const text of encodings) expect(measure(file, text)).toEqual({ [category]: 1 });
});
test("encoded fragments share literal exception limits and zero-debt product rules", () => {
  for (const text of encodings) {
    expect(hangulDebt([{ file: allow[0]!.path, text: `let input = "${text}";` }], allow).counts).toEqual({ "allowed.import-names": 1 });
    expect(hangulDebt([{ file: "apps/web/src/input.ts", text }], []).problems).toHaveLength(1);
  }
});
test.each(["py", "sh", "toml", "yaml"])("hash comments in %s cannot be excepted", extension => {
  const entry = { ...allow[0], path: `scripts/input.test.${extension}` };
  expect(hangulDebt([{ file: entry.path, text: `# "${ko}"` }], [entry]).counts).toEqual({ scripts: 1 });
});
test("bare quoted input stays debt without aborting the scan", () => {
  expect(hangulDebt([{ file: allow[0]!.path, text: `"${ko}"` }], allow).counts).toEqual({ rustTests: 1 });
});
test.each(["https://user@law.go.kr/", "ftp://law.go.kr/"])("publisher credentials and unsupported protocol are refused: %s", source => {
  expect(() => hangulDebt([], [{ ...official, source }])).toThrow(/source/);
});
test("blank exception names are refused", () => {
  expect(() => hangulDebt([], [{ ...official, name: "" }])).toThrow(/unique name/);
});

test("multiline static constructors preserve original debt lines", () => {
  const text = `String.fromCharCode(\n${[...ko].map(char => char.codePointAt(0)).join(",\n")}\n);`;
  expect(measure("e2e/example.spec.ts", text)).toEqual({ e2e: 2 });
});

test("invalid static code points do not crash the text scan", () => {
  for (const value of [-1, 0x110000, points[0]! + 0.5]) expect(measure("scripts/input.js", `String.fromCodePoint(${value})`)).toEqual({});
});

test("all static numeric-literal forms decode as Hangul", () => {
  for (const text of encodings.slice(-6)) expect(measure("e2e/input.spec.ts", text)).toEqual({ e2e: 1 });
});
