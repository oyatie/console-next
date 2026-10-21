// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { HEADER, checked, headerProblems } from "./check-license-headers.mjs";

test("a new source file with the header passes, after a shebang or in a CSS/SQL/HTML comment too", () => {
  expect(headerProblems("a.ts", `// ${HEADER}\nexport const x = 1;\n`)).toEqual([]);
  expect(headerProblems("b.sh", `#!/usr/bin/env bash\n# ${HEADER}\nset -eu\n`)).toEqual([]);
  expect(headerProblems("c.css", `/* ${HEADER} */\n.a{}\n`)).toEqual([]);
  expect(headerProblems("d.sql", `-- ${HEADER}\nselect 1;\n`)).toEqual([]);
  expect(headerProblems("e.html", `<!-- ${HEADER} -->\n<p>x</p>\n`)).toEqual([]);
});

test("a missing header, a late header and a foreign licence fail", () => {
  expect(headerProblems("apps/web/src/x.tsx", "export const X = () => null;\n")).toEqual([
    `apps/web/src/x.tsx: missing "${HEADER}" in the first 5 lines`,
  ]);
  const late = `${"\n".repeat(6)}// ${HEADER}\n`;
  expect(headerProblems("late.rs", late)).toHaveLength(1);
  expect(headerProblems("mit.mjs", "// SPDX-License-Identifier: MIT\nexport {};\n")[0]).toMatch(
    /^mit\.mjs: declares MIT; our files declare/,
  );
});

test("formats without comments and vendored third-party code are out of scope", () => {
  for (const f of ["package.json", "package-lock.json", "a.png", "README.md", "Cargo.lock"]) expect(checked(f)).toBe(false);
  for (const f of ["third-party/rust/vendor/x/src/lib.rs", "node_modules/a/index.js", "apps/web/dist/app.js"])
    expect(headerProblems(f, "no header\n")).toEqual([]);
});

test("this check and its test carry the header themselves", () => {
  for (const f of ["scripts/check-license-headers.mjs", "scripts/check-license-headers.test.ts"])
    expect(headerProblems(f, readFileSync(f, "utf8"))).toEqual([]);
});
