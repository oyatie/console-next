// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { PlanRoot } from "../domain/plan";
import { planOutline } from "../domain/plan";
import { parseOutline } from "../domain/outline";
import { PlanList } from "./plan-list";
beforeAll(() => loadCatalog("ko"));
test("a refused department kind names its original line and how to fix the cell", () => {
  const root: PlanRoot = { kind: "entity", node: { id: "entity", kind: "LEGAL_ENTITY", name: "법인", headcount: 0, direct_headcount: 0, dispatched_headcount: 0, children: [], chips: [] } };
  const rows = planOutline(root, parseOutline("본사\n\t품질팀\t잘못된칸").rows);
  const html = renderToStaticMarkup(<PlanList rows={rows} names={{}} onRename={() => undefined} rootName="법인" levelOffset={0} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("2행 · 부서에는 사업장 종류를 지정할 수 없습니다. 둘째 칸을 비우십시오.");
});
