// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

const script = fileURLToPath(new URL("./check-contrast.mjs", import.meta.url));
const tokens = fileURLToPath(new URL("../packages/tokens/tokens.css", import.meta.url));
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const api = async () => import(/* @vite-ignore */ script);
const run = (css: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "check-contrast-"));
  roots.push(root);
  const file = path.join(root, "tokens.css");
  writeFileSync(file, css);
  return spawnSync("node", [script, "--tokens", file], { encoding: "utf8" });
};

test("all declared text and meaningful non-text pairs pass in light and dark", async () => {
  const { checkContrast } = await api();
  const result = checkContrast(readFileSync(tokens, "utf8"));
  expect(result.problems).toEqual([]);
  expect(result.checked).toBeGreaterThan(100);
  expect(spawnSync("node", [script], { encoding: "utf8" }).status).toBe(0);
});

test("non-text refuses 2.9:1 and accepts the unrounded 3.0:1 threshold", async () => {
  const { contrastRatio, meetsContrast } = await api();
  expect(meetsContrast(2.9, "non-text")).toBe(false);
  expect(meetsContrast(3, "non-text")).toBe(true);
  expect(meetsContrast(4.49, "text")).toBe(false);
  expect(meetsContrast(4.5, "text")).toBe(true);
  expect(contrastRatio("#000", "#fff")).toBe(21);
  const css = readFileSync(tokens, "utf8");
  expect(run(css + '\n:root { --control-border: #999999; }').status).toBe(1);
  expect(run(css + '\n:root { --control-border: #888888; }').status).toBe(0);
});

test("text, focus, meter track and refused outline each have a failing negative control in both themes", () => {
  const css = readFileSync(tokens, "utf8");
  for (const selector of [":root", ':root[data-theme="dark"]']) {
    for (const role of ["ink", "primary", "neutral-solid", "danger-solid"]) {
      const result = run(css + `\n${selector} { --${role}: var(--surface); }`);
      expect(result.status, `${selector} ${role}`).toBe(1);
      expect(result.stderr).toContain(`--${role}`);
    }
  }
});

test("unresolved aliases, alias cycles and unsupported colour values fail closed", () => {
  const css = readFileSync(tokens, "utf8");
  for (const value of ["var(--missing)", "var(--ink)", "not-a-colour"]) {
    const result = run(css + `\n:root { --ink: ${value}; }`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--ink");
  }
});

test("categorical CVD separation refuses duplicate categories", () => {
  const css = readFileSync(tokens, "utf8");
  const result = run(css + '\n:root { --chart-cat-2: var(--chart-cat-1); }');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CVD");
});

test("the pair matrix retains muted surfaces, refused/selected outlines and every semantic text pair", async () => {
  const { checkContrast, themeTokens } = await api();
  const css = readFileSync(tokens, "utf8");
  const themes = themeTokens(css);
  for (const [theme, selector] of [["light", ":root"], ["dark", ':root[data-theme="dark"]']]) {
    // Equal colours force every configured pair to report, making a deleted check observable.
    const planted = `${css}\n${selector} { ${Object.keys(themes[theme]).map((name) => `${name}: #000;`).join(" ")} }`;
    const { problems } = checkContrast(planted);
    const expected: [string, string][] = [];
    for (const fg of ["--ink", "--steel", "--faint", "--primary"]) for (const bg of ["--surface", "--canvas", "--muted"]) expected.push([fg, bg]);
    for (const fg of ["--primary", "--danger-solid"]) for (const bg of ["--primary-soft", "--danger-bg"]) expected.push([fg, bg]);
    for (const name of Object.keys(themes[theme]).filter((name) => name.endsWith("-tx"))) {
      expected.push([name, name.replace(/-tx$/, "-bg")], [name, "--surface"]);
    }
    for (const [fg, bg] of expected) expect(problems.some((problem: string) => problem.startsWith(`${theme}: ${fg}/${bg} 1.0000:1`)), `${theme} ${fg}/${bg}`).toBe(true);
  }
});
