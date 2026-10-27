// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import type { LegalEntity } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { checklistRef } from "../../../reference/entity/api";
import { entityHistoryQuery, entityQuery } from "../api";
import { EntityRecord } from "./entity-record";
import { RegistryCard } from "./record-registry-card";
import type { Act } from "./record-revise-sheet";

beforeAll(() => loadCatalog("ko"));

test.each(["overview", "certificates", "workplaces", "officers", "documents", "history"] as const)("the record opens the accepted %s URL tab under its shared head", async (tab) => {
  const entity = {
    id: "entity", biz_kind: "CORPORATION", can_manage: false,
    current: { name: "주식회사 누리", representatives: ["김대표", "이대표"], directors: [] },
    registrations: [], workplaces: [], scheduled: [], identity_problems: [], name_reviews: [],
    regular_workers: { value: null, status: "HOLD", live_headcount: 0, missing: [], basis: "LSA_DECREE_7_2" },
  } as unknown as LegalEntity;
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  await client.fetchQuery({ ...entityQuery(entity.id), queryFn: async () => entity });
  await client.fetchQuery({ ...entityHistoryQuery(entity.id), queryFn: async () => ({ items: [] }) });
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, id: "app" });
  // Browser coverage exercises the production search validator and URL writes.
  const detail = createRoute({ getParentRoute: () => app, path: "/org/entities/$id", validateSearch: (search) => search });
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([detail])]), history: createMemoryHistory({ initialEntries: [`/org/entities/${entity.id}?tab=${tab}`] }) });
  await router.load();
  const out = renderToStaticMarkup(<QueryClientProvider client={client}><RouterContextProvider router={router}><EntityRecord id={entity.id} /></RouterContextProvider></QueryClientProvider>).replace(/<template>[\s\S]*?<\/template>/g, "");
  expect(out).toContain("<header");
  expect(out).toContain('data-band="true"');
  expect(out).toContain('role="tablist"');
  const selected = out.match(/<[^>]*aria-selected="true"[^>]*role="tab"[^>]*>[^<]*/g);
  expect(selected).toHaveLength(1);
  expect(selected![0]).toContain(t(`entityRecord.tab.${tab}`));
  expect(out).toContain(t("entity.list.title"));
  expect(out).toContain('href="/org/entities"');
  if (tab === "officers") {
    expect(out).toContain("김대표");
    expect(out).toContain("이대표");
    expect(out).toContain(t("entityRecord.officers.none"));
    expect(out.match(/<li>김대표<\/li>|<li>이대표<\/li>/g)).toHaveLength(2);
  }
  const registry = renderToStaticMarkup(<RegistryCard e={entity} act={{ field: () => {} } as unknown as Act} />);
  expect(registry).toContain("김대표");
  expect(registry).toContain("이대표");
  client.clear();
});

test("a pending phase preserves the record and reserves its disabled actions until the phase arrives", async () => {
  const entity = {
    id: "entity", biz_kind: "CORPORATION", can_manage: true,
    current: { name: "주식회사 누리", representatives: [], directors: [] },
    registrations: [], workplaces: [], scheduled: [], identity_problems: [], name_reviews: [],
    regular_workers: { value: null, status: "HOLD", live_headcount: 0, missing: [], basis: "LSA_DECREE_7_2" },
  } as unknown as LegalEntity;
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  await client.fetchQuery({ ...entityQuery(entity.id), queryFn: async () => entity });
  await client.fetchQuery({ ...entityHistoryQuery(entity.id), queryFn: async () => ({ items: [] }) });
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, id: "app" });
  const detail = createRoute({ getParentRoute: () => app, path: "/org/entities/$id", component: () => <EntityRecord id={entity.id} /> });
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([detail])]), history: createMemoryHistory({ initialEntries: [`/org/entities/${entity.id}`] }) });
  await router.load();
  const markup = () => renderToStaticMarkup(<QueryClientProvider client={client}><RouterContextProvider router={router}><EntityRecord id={entity.id} /></RouterContextProvider></QueryClientProvider>);
  const pending = markup();
  expect(pending).toContain(t("entityRecord.tabs"));
  expect(pending).toContain(t("entityRecord.registry.title"));
  expect(pending).not.toContain('data-read-layout="list"');
  const actions = (html: string) => [
    html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g)?.find(tag => tag.includes(t("entityRecord.action.addWorkplace"))),
    html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(tag => tag.includes(t("entityRecord.action.editByCert"))),
  ];
  const [add, edit] = actions(pending);
  expect(add).toContain('aria-disabled="true"');
  expect(add).not.toContain('href=');
  expect(edit).toContain('disabled=""');
  await client.fetchQuery({ ...checklistRef, queryFn: async () => ({ phase: "OPERATING" as const }) });
  for (const action of actions(markup())) {
    expect(action).toBeDefined();
    expect(action).not.toContain('disabled=');
  }
  client.clear();
});
