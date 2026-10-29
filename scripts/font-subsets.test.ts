// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";
import { catalogCharacters, check } from "./font-subsets.mjs";

test("the emitted cmap covers catalog text supported by Pretendard, including numeric identifiers", () => {
  const manifest = check();
  const requested = catalogCharacters();
  expect(manifest.codepoints.length).toBeGreaterThan(400);
  expect(manifest.codepoints.every((c: number) => requested.includes(c))).toBe(true);
  const upstream = readFileSync("node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css", "utf8");
  const ranges = [...upstream.matchAll(/U\+([\da-f]+)(?:-([\da-f]+))?/gi)].map(([, lo, hi]) => [parseInt(lo!, 16), parseInt(hi ?? lo!, 16)]);
  for (const c of requested.filter((c: number) => ranges.some(([lo, hi]) => c >= lo! && c <= hi!))) expect(manifest.codepoints).toContain(c);
  for (const c of "0123456789") expect(manifest.codepoints).toContain(c.codePointAt(0));
});

test("checks-wired: normal CI check and container web builds verify catalog fonts without Python", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const web = JSON.parse(readFileSync("apps/web/package.json", "utf8"));
  expect(root.scripts.check).toContain("npm run build");
  expect(root.scripts.build).toContain("npm run build -w @console/web");
  expect(web.scripts.prebuild).toBe("node ../../scripts/font-subsets.mjs --check");
  expect(readFileSync("deploy/images/console.Dockerfile", "utf8")).toContain("npm run build -w @console/web");
  expect(readFileSync("deploy/images/console.Dockerfile", "utf8")).toContain("COPY scripts/font-subsets.mjs ./scripts/font-subsets.mjs");
  expect(readFileSync("deploy/images/console.Dockerfile.dockerignore", "utf8")).toContain("!scripts/font-subsets.mjs");
  execFileSync("node", ["scripts/font-subsets.mjs", "--check"], { env: { ...process.env, PYTHON: "/unavailable" } });
});

test("the offline font check refuses stale catalogs, tool pins, generator and corrupt assets", () => {
  const root = mkdtempSync(resolve(tmpdir(), "font-catalog-"));
  try {
    const manifest = check();
    const files = [...Object.keys(manifest.inputs), ...["manifest.json", ...Object.keys(manifest.outputs)].map(f => `apps/web/src/generated/fonts/${f}`)];
    for (const file of files) {
      const target = resolve(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(file), target);
    }
    symlinkSync(resolve("node_modules/typescript"), resolve(root, "node_modules/typescript"));
    // One Node startup exercises all refusals instead of importing TypeScript six times.
    const cases = ["packages/i18n/src/catalogs/ko/asof.ts", "apps/web/font-subsets.requirements.txt", "scripts/font-subsets.mjs", "apps/web/src/generated/fonts/catalog.woff2", "apps/web/src/generated/fonts/catalog.css"];
    const exercise = `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { check } from "./scripts/font-subsets.mjs";
      check();
      const cases = ${JSON.stringify(cases)};
      for (const file of cases) {
        const original = readFileSync(file);
        writeFileSync(file, Buffer.concat([original, Buffer.from("\\n// changed\\n")]));
        assert.throws(check, /Font catalog inputs changed|Font subset is corrupt/);
        writeFileSync(file, original);
      }
      process.stdout.write(JSON.stringify(cases));
    `;
    expect(JSON.parse(execFileSync("node", ["--input-type=module", "--eval", exercise], { cwd: root, encoding: "utf8" }))).toEqual(cases);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
