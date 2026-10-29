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

test("the offline font check accepts copy edits with the same glyphs and refuses uncovered syllables or drift", () => {
  const root = mkdtempSync(resolve(tmpdir(), "font-catalog-"));
  try {
    const manifest = check();
    const files = [...Object.keys(manifest.inputs).filter(f => f !== "catalogCharacters"), ...["manifest.json", ...Object.keys(manifest.outputs)].map(f => `apps/web/src/generated/fonts/${f}`)];
    for (const file of files) {
      const target = resolve(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(file), target);
    }
    cpSync(resolve("packages/i18n/src/catalogs"), resolve(root, "packages/i18n/src/catalogs"), { recursive: true });
    symlinkSync(resolve("node_modules/typescript"), resolve(root, "node_modules/typescript"));
    // One Node startup exercises coverage changes and every integrity input.
    const cases = ["apps/web/font-subsets.requirements.txt", "scripts/font-subsets.mjs", "node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2", "node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css", "apps/web/src/generated/fonts/catalog.woff2", "apps/web/src/generated/fonts/catalog.css"];
    const exercise = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { readFileSync, writeFileSync } from "node:fs";
      import { catalogCharacters, check } from "./scripts/font-subsets.mjs";
      check();
      const catalog = "packages/i18n/src/catalogs/ko/asof.ts";
      const original = readFileSync(catalog, "utf8");
      const requested = catalogCharacters();
      const edited = original.replace('"기준일"', '"일준기"');
      assert.notEqual(edited, original);
      writeFileSync(catalog, edited);
      assert.deepEqual(catalogCharacters(), requested);
      check();
      const assets = check().outputs;
      execFileSync(process.execPath, ["scripts/font-subsets.mjs", "--refresh-inputs"], { env: { ...process.env, PYTHON: "/unavailable" } });
      assert.deepEqual(check().outputs, assets);
      const uncovered = Array.from({ length: 0xd7a4 - 0xac00 }, (_, i) => 0xac00 + i).find(c => !requested.includes(c));
      assert.ok(uncovered);
      writeFileSync(catalog, original.replace('"기준일"', JSON.stringify("기준일" + String.fromCodePoint(uncovered))));
      assert.throws(check, { message: "Font catalog inputs changed; run npm run fonts:generate -w @console/web" });
      assert.throws(() => execFileSync(process.execPath, ["scripts/font-subsets.mjs", "--refresh-inputs"], { stdio: "pipe" }));
      writeFileSync(catalog, original);
      const cases = ${JSON.stringify(cases)};
      for (const file of cases) {
        const original = readFileSync(file);
        writeFileSync(file, Buffer.concat([original, Buffer.from("\\n// changed\\n")]));
        assert.throws(check, /Font catalog inputs changed|Font subset is corrupt/);
        if (file !== "scripts/font-subsets.mjs") assert.throws(() => execFileSync(process.execPath, ["scripts/font-subsets.mjs", "--refresh-inputs"], { stdio: "pipe" }));
        writeFileSync(file, original);
      }
      process.stdout.write(JSON.stringify(cases));
    `;
    expect(JSON.parse(execFileSync("node", ["--input-type=module", "--eval", exercise], { cwd: root, encoding: "utf8" }))).toEqual(cases);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
