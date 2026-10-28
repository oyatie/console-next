// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import postcss from "../postcss.config.mjs";
import { breakpoints, mediaQueries } from "../apps/web/src/ui/breakpoints";

test("CSS media queries expand from the shared breakpoint source and reject unknown tokens", () => {
  const expand = (params: string) => {
    const rule = { params, error: (message: string) => new Error(message) };
    postcss.plugins[0].AtRule.media(rule);
    return rule.params;
  };
  expect(expand("(--phone)")).toBe(`(width < ${breakpoints.md}px)`);
  expect(expand("(--tablet)")).toBe(`(width >= ${breakpoints.md}px)`);
  expect(expand("(--below-wide)")).toBe(mediaQueries["below-wide"]);
  expect(() => expand("(--typo)")).toThrow(/Unknown breakpoint/);
  for (const file of ["apps/web/src/app.css", "apps/web/src/ui/page-head/page-head.module.css"])
    expect(readFileSync(file, "utf8")).not.toMatch(/@media[^{}]*\b\d+(px|rem|em)\b/);
});
