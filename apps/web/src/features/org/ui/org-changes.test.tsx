// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { OrgChanges } from "./org-changes";
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({ effective_from: "2026-11-01", effective_to: "2026-11-30" }), useNavigate: () => vi.fn() }), Link: ({ children }: { children: import("react").ReactNode }) => <span>{children}</span> }));
vi.mock("@tanstack/react-query", () => ({ keepPreviousData: vi.fn(), useQueries: () => [], useQuery: () => ({ data: { items: [], total: 0 } }) }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: () => null }));
vi.mock("./use-change-names", () => ({ useChangeNames: () => ({}) }));
vi.mock("./use-org-routed", () => ({ useOrgRouted: () => false }));
beforeAll(() => loadCatalog("ko"));
test("the removable period filter shows both dates", () => {
  const html = renderToStaticMarkup(<OrgChanges />);
  expect(html).toContain("2026. 11. 01.");
  expect(html).toContain("2026. 11. 30.");
  expect(html).toContain("기간 조건 초기화");
});
