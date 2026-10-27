// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api/schema";
import type { Node, Place } from "../../../reference/org/domain/structure";
import { DeptActions } from "./dept-actions";

const reads = vi.hoisted(() => ({ end: undefined as unknown, changes: [] as unknown[], failed: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (q: unknown) => ({ data: JSON.stringify(q).includes("end-options") ? reads.end : { items: reads.changes }, isError: reads.failed }) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }), Link: ({ children, params }: { children: ReactNode; params: { id: string } }) => <span data-href={`/org/changes/${params.id}`}>{children}</span> }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { reads.end = undefined; reads.changes = []; reads.failed = false; });

const node: Node = { id: "dept", kind: "DEPARTMENT", name: "품질팀", children: [], headcount: 1, direct_headcount: 1, dispatched_headcount: 0, chips: [] };
const parent: Node = { ...node, id: "site", kind: "WORKPLACE", name: "본사" };
const place: Place = { node, parent, workplace: parent, entity: parent, path: [parent.name] };
const end: components["schemas"]["OrgUnitEndOptions"] = { org_unit_id: node.id, name: node.name, version: 1, phase: "OPERATING", delete: { allowed: false, refusal: "org_unit_used" }, dissolve: { allowed: true }, members: 1, people_ever: 1, units: 0, can_manage: true };
const render = () => renderToStaticMarkup(<DeptActions place={place} setup={false} />);

test("a blocking change replaces the end button with a status and one open link", () => {
  reads.end = { ...end, dissolve: { allowed: false, refusal: "org_unit_change_open" } };
  reads.changes = [{ id: "change", code: "OC-2026-0001", target: { kind: "ORG_UNIT", ref: node.id } }];
  const html = render();
  expect(html).not.toContain('id="act-dept-delete"');
  expect(html).toContain("OC-2026-0001 진행 중");
  expect(html).toContain('data-href="/org/changes/change">OC-2026-0001 열기</span>');
});

test("enabled panel actions have no standing descriptions", () => {
  reads.end = end;
  const html = render();
  expect(html).toContain(t("orgUnit.act.dissolve"));
  expect(html).not.toContain("aria-describedby");
  expect(html).not.toContain("하위 부서와 구성원을 넘기고 폐지합니다");
});

test("the end action waits for its server options with a focusable reason", () => {
  const html = render();
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>/);
  expect(html).toContain('aria-describedby=');
  expect(html).toContain(t("crud.loading"));
  reads.failed = true;
  const failed = render();
  expect(failed).toContain('id="act-dept-delete"');
  expect(failed).not.toContain('aria-disabled="true"');
});
