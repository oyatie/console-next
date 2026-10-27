// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Node, Place } from "../../../reference/org/domain/structure";
import { DeptPanel } from "./dept-panel";

const { counts } = vi.hoisted(() => ({ counts: vi.fn(() => "shared-unit-counts") }));
vi.mock("../../../reference/org/present", () => ({ unitCounts: counts }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }) }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));
vi.mock("../../../reference/org/ui/structure-members", () => ({ Members: () => null }));
vi.mock("../../../reference/org/ui/order-buttons", () => ({ OrderButtons: () => null }));
vi.mock("./unit-history", () => ({ UnitHistory: () => null }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => counts.mockClear());

const child: Node = { id: "child", kind: "DEPARTMENT", name: "품질팀", children: [], headcount: 136, direct_headcount: 136, dispatched_headcount: 0, chips: [] };
const node: Node = { ...child, id: "unit", name: "본사", children: [child], headcount: 148, direct_headcount: 12, code: "HQ" };
const parent: Node = { ...child, id: "workplace", kind: "WORKPLACE", name: "서울 사업장" };
const place: Place = { node, parent, entity: { ...parent, kind: "LEGAL_ENTITY", name: "법인" }, workplace: parent, path: [parent.name] };
const render = (setup: boolean, readOnly = false) => renderToStaticMarkup(<DeptPanel place={place} setup={setup} readOnly={readOnly} onClose={() => undefined} />);

test.each([true, false])("department vacancy has a direct appoint action, with one rename and one details action (setup %s)", setup => {
  const html = render(setup);
  const basic = html.match(/<section id="dept-basic"[\s\S]*?<\/section>/)?.[0];
  expect(basic).toBeDefined();
  expect(basic?.match(/<button/g)).toHaveLength(1);
  expect(basic).toContain('id="act-dept-head"');
  expect(basic).toContain("부서장 없음");
  expect(basic).toContain("chip--warn");
  expect(basic).toContain(t("orgStructure.corOnly"));
  expect(basic).not.toMatch(/class="[^"]*corOnly/);
  expect(html.match(/id="act-dept-rename"/g)).toHaveLength(1);
  expect(html.match(/id="act-dept-move-row"/g)).toHaveLength(1);
  expect(html).not.toContain('id="act-dept-move"');
  expect(html.match(/id="act-dept-code"/g)).toHaveLength(1);
});

test("department statistics use the same direct and total presenter as the list and card", () => {
  const html = render(false);
  expect(counts).toHaveBeenCalledExactlyOnceWith(node);
  expect(html.match(/shared-unit-counts/g)).toHaveLength(1);
  expect(html).toContain(t("structure.list.people"));
  expect(html).not.toContain(`<dt>${t("orgUnit.stat.total")}</dt>`);
  expect(html).not.toContain(`<dt>${t("orgUnit.stat.direct")}</dt>`);
});

test("historical department facts offer no edit actions", () => {
  const html = render(false, true);
  expect(html).not.toContain('id="dept-actions"');
  expect(html).not.toContain('id="act-dept-code"');
  expect(html).not.toContain('id="act-dept-head"');
});

test("department employee anchors and headings follow the glossary", () => {
  const html = render(false);
  expect(html).toContain("직원 148");
  expect(html).toContain("직속 직원 12");
  expect(html).not.toContain("구성원");
});
