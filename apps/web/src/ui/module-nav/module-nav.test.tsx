// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { partitionBarOverflow } from "../bar-overflow";
import { ModuleNavBar, type ModuleNavItem } from "./module-nav";

beforeAll(async () => {
  await loadCatalog("ko");
});

const SAMPLE_ITEMS: readonly ModuleNavItem[] = [
  { id: "home", label: "Worklist", href: "/inbox", count: 23 },
  { id: "approvals", label: "Approvals", href: "/approvals", count: 0 },
  { id: "people", label: "People", href: "/people" },
  { id: "settings", label: "Settings", href: "/settings" },
];

test("partitionBarOverflow preserves inline items when all fit and keeps activeIndex visible on overflow", () => {
  expect(partitionBarOverflow([80, 90, 70], 260, 40, 2)).toEqual({
    visibleIndices: [0, 1, 2],
    overflowIndices: [],
  });

  // Total 320 > 240; budget = 240 - 40 = 200. Active item 3 (width 70) must remain inline.
  expect(partitionBarOverflow([80, 90, 80, 70], 240, 40, 3)).toEqual({
    visibleIndices: [0, 3],
    overflowIndices: [1, 2],
  });

  expect(partitionBarOverflow([], 200, 40, 0)).toEqual({
    visibleIndices: [],
    overflowIndices: [],
  });
});

test("ModuleNavBar renders a labelled navigation landmark, marks current page, and formats positive counts", () => {
  const markup = html(<ModuleNavBar label="Primary modules" items={SAMPLE_ITEMS} activeId="home" />);
  expect(markup).toContain('<nav aria-label="Primary modules"');
  expect(markup).toContain('href="/inbox"');
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('data-tone="attention">23</data>');
  // Zero count is omitted from the frame bar.
  expect(markup).not.toContain('value="0"');
});

test("ModuleNavBar supports custom router link rendering and renders nothing when items is empty", () => {
  expect(html(<ModuleNavBar label="Empty" items={[]} />)).toBe("");
  const custom = html(
    <ModuleNavBar
      label="Router nav"
      items={SAMPLE_ITEMS.slice(0, 2)}
      activeId="approvals"
      renderLink={(item, props) => (
        <a data-router-to={item.href} {...props}>
          {props.children}
        </a>
      )}
    />,
  );
  expect(custom).toContain('data-router-to="/approvals"');
  expect(custom).toContain('aria-current="page"');
});

test("ModuleNavBar adds zero standing-text blocks to screens that import it", () => {
  const source = readFileSync("apps/web/src/ui/module-nav/module-nav.tsx", "utf8");
  expect(blocks("apps/web/src/ui/module-nav/module-nav.tsx", source)).toBe(0);
});
