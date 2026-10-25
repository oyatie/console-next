// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { RootActions } from "./root-actions";
import { RegistryFilters } from "./registry-bar";
import { FirstRun } from "./first-run";
import { SetupPanel } from "./setup-panel";
import type { Box } from "../domain/layout";
import type { Structure } from "../domain/model";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span>,
  getRouteApi: () => ({ useNavigate: () => vi.fn() }), useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { steps: [] } }) }));
beforeAll(() => loadCatalog("ko"));

test.each([true, false])("chart root has one add entry and no duplicate bulk entries (setup %s)", (setup) => {
  const html = renderToStaticMarkup(<RootActions box={{ x: 0, y: 0, h: 100, w: 200 } as Box} setup={setup} zoom={1} visible={{ x: 0, y: 0, w: 500, h: 500 }} />);
  expect(html.match(/<span data-to=/g)).toHaveLength(1);
  expect(html).toContain(t("structure.tools.addEntity"));
  expect(html).not.toContain("/org/import");
  expect(html).not.toContain(t("structure.import.label"));
});

test("org list filters do not add a second export command", () => {
  const html = renderToStaticMarkup(<RegistryFilters s={{ asOf: "2026-10-25" } as Structure} rows={[]} filters={new Set()} onFilters={() => {}} />);
  expect(html).not.toContain(t("structureChart.list.download"));
  expect(html).toContain(t("structureChart.list.filter.vacant"));
});

test("the first-run canvas leaves bulk actions in the page import menu", () => {
  const html = renderToStaticMarkup(<FirstRun />);
  expect(html.match(/<span data-to=/g)).toHaveLength(1);
  expect(html).toContain('data-to="/org/entities/new"');
  expect((html.match(/<span data-to=[\s\S]*?<\/span>/g) ?? []).join("")).not.toMatch(/가져오기|붙여넣기/);
});

test.each([true, false])("the setup panel leaves bulk actions in the page import menu (first %s)", (first) => {
  const html = renderToStaticMarkup(<SetupPanel first={first} s={{ root: { headcount: 0 }, counts: { entities: 0, sites: 0, depts: 0 } } as Structure} fixLink={() => null} />);
  expect((html.match(/<span data-to=[\s\S]*?<\/span>/g) ?? []).join("")).not.toMatch(/가져오기|붙여넣기/);
  if (!first) expect(html).toContain('data-to="/setup/go-live"');
});

