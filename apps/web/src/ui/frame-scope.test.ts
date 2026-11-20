// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { contrastRatio, experienceFiles, experienceThemes, meetsContrast, themeTokens } from "../../../../scripts/check-contrast.mjs";
import { decodeIdent, experienceBlocks, parseCss } from "../../../../scripts/check-ds-refs.mjs";

const TOKENS_CSS = readFileSync("packages/tokens/tokens.css", "utf8");
const CONSOLE_CSS = readFileSync("packages/tokens/experiences/console.css", "utf8");
const APP_CSS = readFileSync("apps/web/src/app.css", "utf8");

function flatResolve(tokens: Record<string, string>, value: string, seen = new Set<string>()): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => {
    if (seen.has(name)) throw new Error(`cyclic token ${name}`);
    const target = tokens[name];
    if (target === undefined) throw new Error(`undefined token ${name}`);
    return flatResolve(tokens, target, new Set([...seen, name]));
  });
}

/** W3C custom-property inheritance: :root computes its aliases first, then a descendant [data-surface="chrome"] resolves its own declarations against its scope + inherited :root values. */
function resolveChildScope(rootTokens: Record<string, string>, childDecls: Record<string, string>): Record<string, string> {
  const computedRoot = Object.fromEntries(
    Object.entries(rootTokens).map(([name, val]) => [name, flatResolve(rootTokens, val)]),
  );
  const childRaw = { ...computedRoot, ...childDecls };
  return Object.fromEntries(
    Object.entries(childRaw).map(([name, val]) => [name, flatResolve(childRaw, val)]),
  );
}

function parseChromeScope(css: string) {
  const declarations: Record<string, string> = {};
  let colorScheme: string | undefined;
  parseCss(css, "apps/web/src/app.css").walkRules(rule => {
    if (rule.selector.replaceAll("'", '"') !== '[data-surface="chrome"]') return;
    for (const node of rule.nodes ?? []) {
      if (node.type !== "decl" || !node.prop || node.value === undefined) continue;
      const prop = decodeIdent(node.prop);
      if (prop.startsWith("--")) declarations[prop] = node.value.trim();
      else if (prop === "color-scheme") colorScheme = node.value.trim();
    }
  });
  return { declarations, colorScheme };
}

test("base and Console token files define the frame roles, bar insets, kbd sizing, and avatar radius", () => {
  const base = themeTokens(TOKENS_CSS);
  const required = [
    "--chrome",
    "--chrome-raised",
    "--chrome-hover",
    "--chrome-border",
    "--chrome-control-border",
    "--on-chrome",
    "--on-chrome-muted",
    "--chrome-accent",
    "--chrome-attention",
    "--chrome-danger",
    "--chrome-danger-bg",
    "--chrome-danger-bd",
    "--chrome-danger-solid",
    "--chrome-on-danger",
    "--chrome-warn-bg",
    "--chrome-warn-bd",
    "--chrome-scheme",
    "--space-half",
    "--space-1-5",
    "--radius-full",
    "--radius-avatar",
    "--tabbar-h",
    "--statusbar-h",
    "--navbar-h",
    "--kbd-h",
    "--kbd-min-w",
    "--surface-2",
    "--surface-rest",
    "--surface-hover",
    "--surface-pressed",
    "--surface-selected",
    "--border-strong",
    "--control-selected",
    "--on-control-selected",
    "--control-selected-border",
    "--control-text",
    "--link-decoration",
    "--page-pad",
    "--cell-px",
    "--fw-semibold",
    "--lh-tight",
  ];
  for (const name of required) {
    expect(base.light[name], `missing ${name} in tokens.css light`).toBeDefined();
    expect(base.dark[name], `missing ${name} in tokens.css dark`).toBeDefined();
  }
  expect(base.light["--chrome-scheme"]).toBe("light");
  expect(base.dark["--chrome-scheme"]).toBe("dark");
  expect(base.light["--radius-avatar"]).toBe("50%");

  const cr = experienceBlocks(CONSOLE_CSS, "console");
  expect(cr.problems).toEqual([]);
  expect(cr.light["--chrome"]).toBe("#15202b");
  expect(cr.light["--chrome-raised"]).toBe("#202d3a");
  expect(cr.light["--chrome-border"]).toBe("#33414f");
  expect(cr.light["--chrome-control-border"]).toBe("#7f8c99");
  expect(cr.light["--on-chrome"]).toBe("#eef2f6");
  expect(cr.light["--on-chrome-muted"]).toBe("#a7b3c0");
  expect(cr.light["--chrome-accent"]).toBe("#6fd3df");
  expect(cr.light["--chrome-attention"]).toBe("#f5bd4f");
  expect(cr.light["--chrome-danger"]).toBe("#ffb4aa");
  expect(cr.dark["--chrome-danger"]).toBe("#ffb4aa");
  expect(cr.light["--chrome-danger-bg"]).toBe("#402321");
  expect(cr.light["--chrome-warn-bg"]).toBe("#3a2d13");
  expect(cr.dark["--chrome-danger-bg"]).toBeDefined();
  expect(cr.dark["--chrome-warn-bg"]).toBeDefined();
  expect(cr.light["--chrome-scheme"]).toBe("dark");
  expect(cr.light["--radius-avatar"]).toBe("2px");
  expect(cr.light["--kbd-h"]).toBe("16px");
  expect(cr.light["--kbd-min-w"]).toBe("16px");
  expect(cr.dark["--chrome"]).toBe("#0a1017");
});

test("[data-surface='chrome'] repeats every derived token from tokens.css and meets WCAG contrast in every style and theme", () => {
  const base = themeTokens(TOKENS_CSS);
  const { declarations: scope, colorScheme } = parseChromeScope(APP_CSS);
  expect(Object.keys(scope).length).toBeGreaterThan(0);
  expect(colorScheme).toBe("var(--chrome-scheme)");

  // Every token in tokens.css whose value references a re-declared token must also be repeated in [data-surface="chrome"]
  // (excluding --chrome* definitions themselves, which are the source roles).
  const redeclared = new Set(Object.keys(scope));
  const missingDerived: string[] = [];
  for (const [name, value] of Object.entries(base.light)) {
    if (name.startsWith("--chrome") || name === "--on-chrome" || name === "--on-chrome-muted") continue;
    const refs = [...value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(m => m[1]!);
    if (refs.some(ref => redeclared.has(ref)) && !redeclared.has(name)) {
      missingDerived.push(name);
    }
  }
  expect(missingDerived).toEqual([]);

  const overlays = [
    { label: "baseline", themes: base },
    ...experienceFiles("packages/tokens/tokens.css").map(file => {
      const id = file.split("/").pop()!.replace(/\.css$/, "");
      return { label: id, themes: experienceThemes(base, experienceBlocks(readFileSync(file, "utf8"), id)) };
    }),
  ];

  for (const { label, themes } of overlays) {
    for (const mode of ["light", "dark"] as const) {
      const merged = resolveChildScope(themes[mode], scope);
      for (const fg of ["--ink", "--steel", "--faint", "--primary", "--warn-tx", "--danger-tx"]) {
        for (const bg of ["--surface", "--canvas", "--muted", "--primary-soft"]) {
          const ratio = contrastRatio(merged[fg]!, merged[bg]!);
          expect(meetsContrast(ratio, "text"), `${label} ${mode} chrome scope ${fg} on ${bg}: ${ratio.toFixed(2)}:1`).toBe(true);
        }
      }
      const onPrimaryRatio = contrastRatio(merged["--on-primary"]!, merged["--primary"]!);
      expect(meetsContrast(onPrimaryRatio, "text"), `${label} ${mode} chrome scope --on-primary on --primary: ${onPrimaryRatio.toFixed(2)}:1`).toBe(true);
      for (const [fg, bg] of [
        ["--danger-tx", "--danger-bg"],
        ["--over-tx", "--over-bg"],
        ["--warn-tx", "--warn-bg"],
        ["--on-danger", "--danger-solid"],
        ["--on-danger", "--danger-tx"],
      ] as const) {
        const ratio = contrastRatio(merged[fg]!, merged[bg]!);
        expect(meetsContrast(ratio, "text"), `${label} ${mode} chrome scope ${fg} on ${bg}: ${ratio.toFixed(2)}:1`).toBe(true);
      }
      for (const bg of ["--surface", "--canvas", "--muted", "--primary-soft"]) {
        const edgeRatio = contrastRatio(merged["--control-border"]!, merged[bg]!);
        expect(meetsContrast(edgeRatio, "non-text"), `${label} ${mode} chrome scope --control-border on ${bg}: ${edgeRatio.toFixed(2)}:1`).toBe(true);
      }
      for (const bg of ["--surface", "--canvas", "--muted", "--danger-bg"]) {
        const solidRatio = contrastRatio(merged["--danger-solid"]!, merged[bg]!);
        expect(meetsContrast(solidRatio, "non-text"), `${label} ${mode} chrome scope --danger-solid on ${bg}: ${solidRatio.toFixed(2)}:1`).toBe(true);
      }
    }
  }
});
