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

  // Persistent trailing controls (e.g. WorkspaceTabs add button) force overflow when items + persistentReserve > width.
  expect(partitionBarOverflow([100, 100], 220, 70, 0, 32)).toEqual({
    visibleIndices: [0],
    overflowIndices: [1],
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

test("a count the badge cannot say alone reaches the link as its name and description, and a lower bound reads with a plus", () => {
  const items: readonly ModuleNavItem[] = [
    { id: "/", label: "To-dos", href: "/", count: 1234, countMore: true, name: "To-dos 1234+", description: "1,234 or more to-dos" },
    { id: "/people", label: "People", href: "/people", name: "People · loading" },
  ];
  for (const markup of [
    html(<ModuleNavBar label="Main menu" items={items} />),
    html(<ModuleNavBar label="Main menu" items={items} renderLink={(_, props) => <a {...props}>{props.children}</a>} />),
  ]) {
    const todo = markup.match(/<a [^>]*aria-label="To-dos 1234\+"[^>]*>/)?.[0] ?? "";
    const describedBy = todo.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`<bdi id="${describedBy}" class="sr-only">1,234 or more to-dos</bdi>`);
    expect(markup).toContain('data-tone="attention">1,234+</data>');
    // A name with no count to describe carries no description.
    expect(markup).toMatch(/<a [^>]*aria-label="People · loading"(?![^>]*aria-describedby)[^>]*>/);
  }
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
