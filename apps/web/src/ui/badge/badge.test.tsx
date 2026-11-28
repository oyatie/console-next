// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { Badge } from "./badge";

test("Badge formats counts and exposes neutral, attention, and inverse tones", () => {
  expect(html(<Badge count={23} />)).toBe('<data value="23" data-count="" class="' + (html(<Badge count={23} />).match(/class="([^"]+)"/)?.[1] ?? "") + '" data-tone="neutral">23</data>');
  expect(html(<Badge count={2054} tone="attention" />)).toContain('data-tone="attention"');
  expect(html(<Badge count={2054} tone="attention" />)).toContain("2,054");
  expect(html(<Badge count={4} tone="inverse" />)).toContain('data-tone="inverse"');
});

test("Badge adds zero standing-text blocks to screens that import it", () => {
  const source = readFileSync("apps/web/src/ui/badge/badge.tsx", "utf8");
  expect(blocks("apps/web/src/ui/badge/badge.tsx", source)).toBe(0);
});
