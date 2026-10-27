// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { Node, Place } from "../../../reference/org/domain/structure";
import { DeptDissolveSheet } from "./dept-dissolve-sheet";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [], members: { items: [{ employeeId: "employee", name: "김직원" }] } } }) }));
vi.mock("./use-govern", () => ({ useGovern: () => ({ g: { date: "2026-11-01", reason: "조직 개편" }, today: "2026-10-27", missing: [] }), useGovernSubmit: () => ({}) }));
vi.mock("./govern-fields", () => ({ GovernFields: () => null }));
vi.mock("../../../ui/composer/composer", () => ({ Composer: ({ title, subtitle, children, consequence }: { title: string; subtitle?: ReactNode; children: ReactNode; consequence: ReactNode }) => <div><h2>{title}</h2>{subtitle}{children}{consequence}</div> }));
beforeAll(() => loadCatalog("ko"));

test("dissolution names the required assignments and counted destination without a subtitle", () => {
  const node: Node = { id: "dept", kind: "DEPARTMENT", name: "품질팀", children: [], headcount: 1, direct_headcount: 1, dispatched_headcount: 0, chips: [] };
  const parent: Node = { ...node, id: "site", kind: "WORKPLACE", name: "본사" };
  const place: Place = { node, parent, workplace: parent, entity: parent, path: [parent.name] };
  const html = renderToStaticMarkup(<DeptDissolveSheet place={place} places={new Map([[parent.id, { ...place, node: parent }]])} company="회사" onClose={vi.fn()} />);
  expect(html).toContain("폐지 전 지정");
  expect(html).toContain("전보 대상 1명 · 본사 직속");
  expect(html).not.toContain("운영 중이라 조직 변경으로 기록되고");
});
