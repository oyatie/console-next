// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { components } from "@console/api/schema";
import { UnitHistory } from "./unit-history";
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to }: { children: import("react").ReactNode; to: string }) => <span data-to={to}>{children}</span> }));
vi.mock("../../../lib/react/outcome-link", () => ({ OutcomeLink: () => null }));
beforeAll(() => loadCatalog("ko"));
type Change = components["schemas"]["OrgChangeSummary"];
test("unit history puts scheduled actions above revisions in effective date order", () => {
  const change = (id: string, date: string): Change => ({ id, code: id, kind: "REORG", status: "APPROVED", target: { kind: "ORG_UNIT", ref: "unit", label: "품질팀" }, effectiveDate: date, reason: "개편", headcount: 0, siteCount: 0, teamCount: 1, draftedBy: "actor", draftedByName: "김인사", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  const html = renderToStaticMarkup(<UnitHistory open revisions={[]} units={[]} scheduled={[change("OC-later", "2026-12-02"), change("OC-earlier", "2026-11-02")]} />);
  expect(html).toContain("OC-earlier");
  expect(html).toContain("OC-later");
  expect(html.indexOf("OC-earlier")).toBeLessThan(html.indexOf("OC-later"));
  expect(html).toContain("김인사");
  expect(html).toContain("예정");
});
