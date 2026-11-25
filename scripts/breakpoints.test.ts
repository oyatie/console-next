// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postcss, { type AtRule } from "postcss";
import { preprocessCSS, resolveConfig } from "vite";
import { expect, test } from "vitest";
import config from "../postcss.config.mjs";
import { breakpoints, mediaQueries } from "../apps/web/src/ui/breakpoints";

test("CSS media queries expand from the shared breakpoint source and reject unknown tokens", () => {
  const expand = (params: string) => (postcss(config.plugins).process(`@media ${params} {}`, { from: undefined }).root.first as AtRule).params;
  expect(expand("(--phone)")).toBe(`(width < ${breakpoints.md}px)`);
  expect(expand("(--tablet)")).toBe(`(width >= ${breakpoints.md}px)`);
  expect(expand("(--below-wide)")).toBe(mediaQueries["below-wide"]);
  expect(() => expand("(--typo)")).toThrow(/Unknown breakpoint/);
  for (const file of ["apps/web/src/app.css", "apps/web/src/ui/page-head/page-head.module.css"])
    expect(readFileSync(file, "utf8")).not.toMatch(/@media[^{}]*\b\d+(px|rem|em)\b/);
});

test("a CSS module ships the breakpoints of the file it composes from expanded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breakpoints-"));
  try {
    writeFileSync(join(dir, "base.module.css"), "@media (--phone) { .row { gap: 0; } }");
    const resolved = await resolveConfig({ configFile: false, root: dir, logLevel: "silent", css: { postcss: config } }, "build");
    const { code } = await preprocessCSS('.card { composes: row from "./base.module.css"; }', join(dir, "card.module.css"), resolved);
    expect(code).toContain(`@media ${mediaQueries.phone}`);
    expect(code).not.toContain("(--phone)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
