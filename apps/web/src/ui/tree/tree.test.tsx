// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { TreeView } from "./tree";

beforeAll(() => loadCatalog("ko"));

type Node = { id: string; name: string; children?: Node[] };

const data: Node[] = [
  {
    id: "corp",
    name: "Acme Corp",
    children: [
      { id: "dept1", name: "Engineering", children: [{ id: "team1", name: "Frontend" }] },
      { id: "dept2", name: "Product" },
    ],
  },
];

test("TreeView renders hierarchical tree nodes with labels", () => {
  const out = html(
    <TreeView
      label="Organization"
      roots={data}
      childrenOf={(n) => n.children ?? []}
      textValue={(n) => n.name}
      row={(n) => <span>{n.name}</span>}
      expanded={new Set(["corp", "dept1"])}
      onExpandedChange={() => undefined}
      onSelect={() => undefined}
    />
  );
  expect(out).toContain("Acme Corp");
  expect(out).toContain("Engineering");
  expect(out).toContain("Frontend");
  expect(out).toContain("Product");
});

test("TreeView renders loading state with skeleton and aria-busy", () => {
  const out = html(
    <TreeView
      label="Organization"
      roots={[] as Node[]}
      childrenOf={() => []}
      textValue={(n) => n.name}
      row={(n) => n.name}
      expanded={new Set()}
      onExpandedChange={() => undefined}
      onSelect={() => undefined}
      loading
    />
  );
  expect(out).toContain('aria-busy="true"');
  expect(out).toContain('role="status"');
});

test("TreeView renders empty state keeps its labelled container without domain prose", () => {
  const out = html(
    <TreeView
      label="Organization"
      roots={[] as Node[]}
      childrenOf={() => []}
      textValue={(n) => n.name}
      row={(n) => n.name}
      expanded={new Set()}
      onExpandedChange={() => undefined}
      onSelect={() => undefined}
    />
  );
  expect(out).not.toContain("조직도");
  expect(out).toContain('aria-label="Organization"');
});

test("TreeView renders error state with role alert and data-state error", () => {
  const out = html(
    <TreeView
      label="Organization"
      roots={[] as Node[]}
      childrenOf={() => []}
      textValue={(n) => n.name}
      row={(n) => n.name}
      expanded={new Set()}
      onExpandedChange={() => undefined}
      onSelect={() => undefined}
      error="Tree failed to load"
    />
  );
  expect(out).toContain('role="alert"');
  expect(out).toContain('data-state="error"');
  expect(out).toContain("Tree failed to load");
});
