// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { EffectuateConsequence } from "./effectuate-consequence";

const { units } = vi.hoisted(() => ({ units: vi.fn(() => ({ data: { items: [{ id: "from", headcount: 5 }] }, isFetchedAfterMount: true })) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: units }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ q, children }: { q: { data: unknown }; children: (data: unknown) => ReactNode }) => children(q.data) }));
vi.mock("./use-change-names", () => ({ useChangeNames: () => ({ unit: (id: string) => id === "from" ? "원부서" : "받는부서" }) }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => units.mockClear());

const detail: components["schemas"]["OrgChangeDetail"] = {
  id: "change", code: "OC-2026-0012", kind: "REORG", status: "IN_APPROVAL", target: { kind: "ORG_UNIT", ref: "from", label: "원부서" },
  effectiveDate: "2026-10-25", reason: "한 명의 소속 변경", headcount: 1, siteCount: 0, teamCount: 1,
  draftedBy: "drafter", draftedByName: "김인사", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z",
  proposal: [{ op: "REASSIGN_ORG_UNIT", fromOrgUnit: "from", toOrgUnit: "to", scope: { company: "company" }, employeeIds: ["employee"] }],
  settlementItems: [], events: [], approvalSteps: [],
};

test("the decision uses the server's affected person count for a partial reassignment", () => {
  const html = renderToStaticMarkup(<EffectuateConsequence d={detail} />);
  const text = (count: number) => t("org.change.effectuate.reassign", { code: detail.code, from: "원부서", to: "받는부서", count });
  expect(html).toContain(text(detail.headcount));
  expect(html).not.toContain(text(5));
  expect(units).not.toHaveBeenCalled();
});

test("a non-transfer decision retains its action consequence", () => {
  const html = renderToStaticMarkup(<EffectuateConsequence d={{ ...detail, proposal: [] }} />);
  expect(html).toContain(t("org.change.effectuate.apply", { code: detail.code }));
  expect(units).not.toHaveBeenCalled();
});
