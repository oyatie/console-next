// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { Members } from "./structure-members";

const state = vi.hoisted(() => ({ reads: [] as Record<string, unknown>[] }));
vi.mock("../../authz/ui/use-can", () => ({ useCan: () => () => true }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../../lib/query", async (original) => {
  const actual = await original<typeof import("../../../lib/query")>();
  return { ...actual, get: (...args: Parameters<typeof actual.get>) => ({ ...actual.get(...args), path: args[0], params: args[1]?.params }) };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: Record<string, unknown>) => {
    state.reads.push(options);
    return { isPending: false, data: String(options.path).endsWith("/members") ? { headcount: 1, items: [{ employeeId: "historical", name: "과거구성원" }] } : undefined };
  },
  useQueryClient: () => ({ getQueryState: () => undefined }),
}));
beforeAll(() => loadCatalog("ko"));

test.each(["2020-03-02", "2099-03-02"])("members use the chart snapshot at %s without today's joiners", (as_of) => {
  state.reads = [];
  const html = renderToStaticMarkup(<Members unitId="unit" total={1} expected={1} as_of={as_of} known_at="2026-10-22T00:00:00Z" />);
  expect(state.reads[0]).toMatchObject({ path: "/api/v1/org-structure/units/{orgUnitId}/members", params: { path: { orgUnitId: "unit" }, query: { as_of, known_at: "2026-10-22T00:00:00Z" } } });
  expect(state.reads[1]).toMatchObject({ enabled: false });
  expect(html).toContain("과거구성원");
  expect(html).not.toContain(t("orgStructure.members.all", { count: 1 }));
  expect(html).not.toContain(t("orgStructure.members.joinersRestricted"));
});
