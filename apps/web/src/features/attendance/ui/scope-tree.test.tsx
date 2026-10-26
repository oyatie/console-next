// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { ScheduleTree } from "../api";
import type { TreeNode } from "../domain/tree";
import { ScopeTree } from "./scope-tree";

vi.mock("./person-scope", () => ({ PersonScope: () => null }));
vi.mock("../../../ui/tree/tree", () => ({ TreeView: ({ roots, childrenOf, row }: {
  roots: TreeNode[]; childrenOf: (n: TreeNode) => TreeNode[]; row: (n: TreeNode) => ReactNode;
}) => {
  const render = (n: TreeNode): ReactNode => <div key={n.id} data-node={n.id}>{row(n)}{childrenOf(n).map(render)}</div>;
  return roots.map(render);
} }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, search }: {
  children: ReactNode; to: string; search: Record<string, unknown>;
}) => <span data-href={`${to}?${new URLSearchParams(Object.entries(search).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`}>{children}</span> }));
beforeAll(() => loadCatalog("ko"));

function renderTree(effective: { pattern_name: string; from: "LEGAL_ENTITY" } | null = null, unscheduled = 3) {
  const nodes = [
    { id: "entity", kind: "LEGAL_ENTITY", name: "법인", people: 3, effective, unscheduled },
    { id: "wp", parent_id: "entity", kind: "WORKPLACE", name: "판교지점", people: 3, effective, unscheduled },
    { id: "team", parent_id: "wp", workplace_id: "wp", kind: "DEPARTMENT", name: "영업1팀", people: 3, effective, unscheduled },
    { id: "crew", parent_id: "wp", kind: "CREW", name: "주간조", people: 0, effective: null, unscheduled: 0 },
  ];
  return renderToStaticMarkup(<ScopeTree tree={{ date: "2026-10-26", nodes, people_total: 3, people_unscheduled: unscheduled, holidays_loaded: true } as ScheduleTree} onSelect={() => {}} onPerson={() => {}} />);
}

test("a scope with no effective schedule warns honestly and each node shows its served headcount", () => {
  const html = renderTree();
  expect(html).toContain('class="t-warn">일정 없음</span>');
  expect(html).not.toContain("따름");
  expect(html).not.toContain("법인 기본 없음");
  expect(html.match(/일정 없음 3명/g)).toHaveLength(3);
  expect(html.match(/일정 없음/g)).toHaveLength(4);
  expect(html).toContain("0명");
  expect(html).not.toContain("지정되지 않은 사람");
});

test("counts link only scopes supported by the day board, keeping the tree date", () => {
  const html = renderTree();
  const urls = [...html.matchAll(/href="([^"]+)"/g)].map(m => new URL(m[1]!.replaceAll("&amp;", "&"), "https://console.invalid"));
  expect(urls).toHaveLength(2);
  expect(urls.map(u => Object.fromEntries(u.searchParams))).toEqual([
    { tab: "day", date: "2026-10-26", unscheduled: "true", wp: "wp" },
    { tab: "day", date: "2026-10-26", unscheduled: "true", wp: "wp", unit: "team" },
  ]);
  expect(urls.every(u => u.pathname === "/attendance")).toBe(true);
});

test("inherited schedules show the resolved pattern and translated source; only all-clear keeps a footer", () => {
  const html = renderTree({ pattern_name: "사무 일정", from: "LEGAL_ENTITY" }, 0);
  expect(html).toContain("사무 일정 · 법인 기준");
  expect(html).not.toContain("LEGAL_ENTITY");
  expect(html).toContain("3명 모두 근무 일정이 있습니다");
});
