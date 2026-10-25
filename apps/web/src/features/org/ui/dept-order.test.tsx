// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { ToggleButton } from "../../../ui/button/button";
import type { Node, Place } from "../../../reference/org/domain/structure";
import { DeptPanel } from "./dept-panel";

const view = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], toggle: undefined as Parameters<typeof ToggleButton>[0]["onClick"] }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const slot = view.cursor++;
    if (!(slot in view.values)) view.values[slot] = initial;
    return [view.values[slot], (next: unknown) => { view.values[slot] = typeof next === "function" ? next(view.values[slot]) : next; }];
  } };
});
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { revisions: [], items: [] } }) }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isPending: false }) }));
vi.mock("./dept-actions", () => ({ DeptActions: () => null }));
vi.mock("./dept-details", () => ({ DeptDetails: () => null }));
vi.mock("./unit-history", () => ({ UnitHistory: () => null }));
vi.mock("../../../reference/org/ui/structure-members", () => ({ Members: () => null }));
vi.mock("../../../reference/org/ui/dept-name-inline", () => ({ DeptNameInline: () => null }));
vi.mock("../../../ui/record-actions/record-actions", () => ({ RowActions: () => null }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, ToggleButton: (props: Parameters<typeof ToggleButton>[0]) => {
    view.toggle = props.onClick;
    return <actual.ToggleButton {...props} />;
  } };
});

const node = (name: string, children: Node[] = []): Node => ({ id: name, name, kind: "DEPARTMENT", children, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [] });
const children = [node("첫째 부서"), node("마지막 부서")];
const parent = { ...node("사업장"), kind: "WORKPLACE" as const };
const entity = { ...node("법인"), kind: "LEGAL_ENTITY" as const };
const place: Place = { node: node("상위 부서", children), parent, entity, workplace: parent, path: [entity.name, parent.name] };
function render(readOnly = false, subdepartments = place.node.children) {
  view.cursor = 0;
  view.toggle = undefined;
  return renderToStaticMarkup(<DeptPanel place={{ ...place, node: { ...place.node, children: subdepartments } }} setup onClose={() => {}} readOnly={readOnly} />);
}
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.values = []; });

test("subdepartments show no reorder arrows before the explicit edit toggle", () => {
  const html = render();
  expect(html).toContain('aria-pressed="false"');
  expect(html).not.toContain(t("orgStructure.order.down", { name: children[0]!.name }));
  expect(html).not.toContain(t("orgStructure.order.up", { name: children[1]!.name }));
});

test("the order toggle exposes possible moves and hides them when turned off", () => {
  render();
  expect(view.toggle).toBeDefined();
  view.toggle?.({} as MouseEvent<HTMLButtonElement>);
  const editing = render();
  expect(editing).toContain('aria-pressed="true"');
  expect(editing).toContain(t("orgStructure.order.down", { name: children[0]!.name }));
  expect(editing).toContain(t("orgStructure.order.up", { name: children[1]!.name }));
  expect(editing).not.toContain(t("orgStructure.order.up", { name: children[0]!.name }));
  expect(editing).not.toContain(t("orgStructure.order.down", { name: children[1]!.name }));
  view.toggle?.({} as MouseEvent<HTMLButtonElement>);
  expect(render()).not.toContain(t("orgStructure.order.down", { name: children[0]!.name }));
});

test("read-only and single-child panels offer no order editor", () => {
  const html = render(true);
  expect(view.toggle).toBeUndefined();
  expect(html).not.toContain('aria-pressed=');
  expect(html).not.toContain(t("orgStructure.order.down", { name: children[0]!.name }));
  expect(render(false, [children[0]!])).not.toContain('aria-pressed=');
});
