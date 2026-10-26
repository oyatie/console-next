// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { structure } from "../../../../e2e/mock/fixtures";
import { placesOf } from "../reference/org/domain/structure";
import { BulkMovePage } from "../features/org/ui/bulk-move-page";
import { PastePage } from "../features/org-bulk/ui/paste-page";
import { structureQuery } from "../features/org-bulk/api";
import { ImportPage } from "../features/org-bulk/ui/import-page";

const fixture = vi.hoisted(() => ({ data: undefined as ReturnType<typeof structure> | undefined, error: null as unknown, search: {} as Record<string, string> }));
const query = () => ({ data: fixture.data, error: fixture.error, isPending: !fixture.data && !fixture.error, isSuccess: !!fixture.data, refetch: vi.fn() });
vi.mock("@tanstack/react-query", async original => ({ ...await original<object>(), useQuery: (q: unknown) => q === structureQuery ? query() : { data: { items: [] }, isSuccess: true } }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  getRouteApi: () => ({ useSearch: () => fixture.search, useNavigate: () => vi.fn() }),
  Link: ({ to, search, children, ...props }: { to: string; search?: Record<string, string>; children: ReactNode }) => <span data-to={to} data-search={search && new URLSearchParams(search).toString()} {...props}>{children}</span>,
}));
vi.mock("../reference/authz/ui/access-gate", () => ({ AccessGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("../reference/org/ui/use-structure", () => ({ useStructure: () => ({ q: query(), places: fixture.data ? placesOf(fixture.data) : new Map(), setup: fixture.data?.phase !== "OPERATING", tenant: "검증 회사" }) }));
vi.mock("../lib/react/command", () => ({ useCommand: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("../features/org/ui/use-govern", () => ({ useGovern: () => ({ g: { date: "", reason: "" }, missing: [], routed: false }), useGovernSubmit: () => ({ mutate: vi.fn(), isPending: false }) }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { fixture.data = undefined; fixture.error = null; fixture.search = {}; });

for (const [name, Page] of [["move", BulkMovePage], ["paste", PastePage], ["import", ImportPage]] as const) {
  test.each(["pending", "failed"])(`${name} keeps one page heading and close action when the structure read is %s`, state => {
    fixture.error = state === "failed" ? new ApiError(503, "service_unavailable", "", [], "work-page-read") : null;
    const html = renderToStaticMarkup(<Page />);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("닫");
    if (state === "pending") expect(html).toContain("data-read-layout");
    else {
      expect(html.split(t("common.loadFailed.title"))).toHaveLength(2);
      expect(html).toContain("work-page-read");
      expect(html).not.toContain("<textarea");
    }
  });
}

test("paste without a legal entity offers the existing registration route", () => {
  fixture.data = structure(0);
  fixture.data.phase = "SETUP";
  const html = renderToStaticMarkup(<PastePage />);
  expect(html).toContain('data-to="/org/entities/new"');
  expect(html).toContain(t("entity.empty.action"));
  expect(html).not.toContain("<textarea");
});

test.each([false, true])("operating paste omits the editor and apply action, selected root: %s", selected => {
  fixture.data = structure(3);
  if (selected) fixture.search = { workplace: fixture.data.entities[0]!.children[0]!.id };
  const html = renderToStaticMarkup(<PastePage />);
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain('id="plan-title"');
  expect(html).not.toContain('aria-describedby="paste-foot"');
  expect(html).toContain("act=dept-add");
  expect(html).toContain(fixture.data.entities[0]!.children[0]!.id);
});

test("setup paste keeps its selected editor under one page heading", () => {
  fixture.data = structure(3);
  fixture.data.phase = "SETUP";
  fixture.search = { workplace: fixture.data.entities[0]!.children[0]!.id };
  const html = renderToStaticMarkup(<PastePage />);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("<textarea");
  expect(html).toContain('aria-describedby="paste-foot"');
});
