// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { OrgStructureNode } from "@console/api/pending";
import { loadCatalog } from "@console/i18n";
import { buildStructure } from "../domain/model";
import { registryRows, vacantHeads } from "../domain/registry";
import { HeadCell, RegistryFilters } from "./registry-bar";
import { SetupPanel } from "./setup-panel";

vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }), Link: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { steps: [{ key: "org", state: "attention", remedy: "assign_department", count: 3 }] } }) }));
beforeAll(() => loadCatalog("ko"));
const node = (kind: OrgStructureNode["kind"], id: string, children: OrgStructureNode[] = []): OrgStructureNode =>
  ({ kind, id, name: id, children, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [] });
const filled = { ...node("DEPARTMENT", "filled"), head: { employee_id: "head", name: "김부서장", since: null, concurrent: false } };
const s = buildStructure({ tenant_name: "T", phase: "SETUP", unplaced: [], entities: [node("LEGAL_ENTITY", "entity", [node("WORKPLACE", "site", [node("DEPARTMENT", "a", [node("DEPARTMENT", "b")]), filled])])] });

test("one vacancy set counts departments only and is exactly the flat vacancy filter", () => {
  expect(vacantHeads(s)).toEqual({ count: 2, ids: ["a", "b"] });
  const rows = registryRows(s, { level: "dept", q: "", filters: new Set(["vacant"]), closed: new Set() });
  expect(rows.map(n => n.id)).toEqual(vacantHeads(s).ids);
  expect(vacantHeads(buildStructure({ tenant_name: "T", phase: "SETUP", unplaced: [], entities: [] }))).toEqual({ count: 0, ids: [] });
});

test("the list chip and setup department step show the same vacancy count", () => {
  const filters = renderToStaticMarkup(<RegistryFilters s={s} rows={[]} filters={new Set()} onFilters={() => undefined} vacancyCount={vacantHeads(s).count} />);
  expect(filters).toContain("부서장 없음 2");
  const panel = renderToStaticMarkup(<SetupPanel s={s} fixLink={code => <span>{code}</span>} />);
  expect(panel).toContain("부서장 없음 2");
  expect(panel).toContain("부서 없는 직원 3명");
  expect(panel).toContain("assign_department");
});

test("the vacant list head has one warning and a direct appoint action; history stays read only", () => {
  const n = s.byId.get("a")!;
  const html = renderToStaticMarkup(<HeadCell n={n} />);
  expect(html).toContain("부서장 없음");
  expect(html).toContain('aria-label="부서장 지정"');
  expect(html).toContain("chip--warn");
  expect(renderToStaticMarkup(<HeadCell n={n} readOnly />)).not.toContain("<button");
  expect(renderToStaticMarkup(<HeadCell n={s.byId.get("filled")!} />)).toContain("김부서장");
});
