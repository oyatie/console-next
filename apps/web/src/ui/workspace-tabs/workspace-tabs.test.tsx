// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { WorkspaceTabs, type WorkspaceTab } from "./workspace-tabs";

beforeAll(async () => {
  await loadCatalog("ko");
});

const SAMPLE_TABS: readonly WorkspaceTab[] = [
  { id: "home", label: "Worklist", href: "/", count: 23 },
  { id: "people", label: "People", href: "/people" },
  { id: "pinned-extra", label: "Pinned Audit", href: "/audit", pinned: true },
];

test("WorkspaceTabs pins the first tab and any pinned tab, placing close buttons as siblings of links", () => {
  const markup = html(
    <WorkspaceTabs
      label="Open workspaces"
      tabs={SAMPLE_TABS}
      activeId="people"
      closeTabLabel={name => `Close ${name}`}
      newTabLabel="New tab"
      onClose={() => {}}
      onAdd={() => {}}
    />,
  );
  expect(markup).toContain('<nav aria-label="Open workspaces"');
  // Only "People" is closable (index 0 is pinned automatically; index 2 has pinned: true).
  expect(markup).toContain('aria-label="Close People"');
  expect(markup).not.toContain('aria-label="Close Worklist"');
  expect(markup).not.toContain('aria-label="Close Pinned Audit"');
  expect(markup).toContain('aria-label="New tab"');
  // Never nest <button> inside <a>; close button sits immediately after </a>.
  expect(markup).toContain("</a><button");
  expect(markup).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<button\b/);
});

test("a tab whose title is still on its way draws no close, and the strip no new-tab button, until the title lands", () => {
  const strip = (pending: boolean) => html(
    <WorkspaceTabs
      tabs={[{ id: "home", label: "To-dos", href: "/" }, { id: "record", label: "Entity", href: "/org/entities/1", pending }]}
      activeId="record"
      closeTabLabel={name => `Close ${name}`}
      newTabLabel="New tab"
      onClose={() => {}}
      onAdd={() => {}}
    />,
  );
  // Both sit after the title and would move when the longer title lands, so they wait for it. The strip's rule after
  // the tabs stays drawn.
  const held = strip(true);
  expect(held).not.toContain('aria-label="Close Entity"');
  expect(held).not.toContain('aria-label="New tab"');
  expect(held).toMatch(/<\/ul><div class="[^"]*"><\/div><\/nav>$/);
  const settled = strip(false);
  expect(settled).toContain('aria-label="Close Entity"');
  expect(settled).toContain('aria-label="New tab"');
});

test("WorkspaceTabs renders nothing when tabs is empty and adds zero standing-text blocks", () => {
  expect(html(<WorkspaceTabs tabs={[]} />)).toBe("");
  const source = readFileSync("apps/web/src/ui/workspace-tabs/workspace-tabs.tsx", "utf8");
  expect(blocks("apps/web/src/ui/workspace-tabs/workspace-tabs.tsx", source)).toBe(0);
});
