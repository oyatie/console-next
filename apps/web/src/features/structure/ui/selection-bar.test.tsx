// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { buildStructure } from "../domain/model";
import { structure } from "../../../../../../e2e/mock/fixtures";
import { SelectionBar } from "./selection-bar";

const reads = vi.hoisted(() => ({ end: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: reads.end }) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }) }));
beforeAll(() => loadCatalog("ko"));

test.each([[false, "부서 폐지"], [true, "부서 삭제"]])("selection end label follows server delete.allowed=%s in operation", (allowed, label) => {
  const s = buildStructure(structure(2));
  const depts = [...s.byId.values()].filter(n => n.kind === "dept");
  reads.end = { delete: { allowed }, dissolve: { allowed: !allowed } };
  const html = renderToStaticMarkup(<SelectionBar s={s} c={{ sel: new Set(depts.map(n => n.id)), setSel: vi.fn(), cursor: depts[0]!.id, byKeys: false }} g={{ move: vi.fn(), remove: vi.fn() }} />);
  expect(html).toContain(label);
  expect(html).not.toMatch(/>삭제<\/button>/);
});
