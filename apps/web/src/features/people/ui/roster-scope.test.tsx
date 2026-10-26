// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { myAccessQuery } from "../../../reference/authz/api";
import { entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { unitsQuery } from "../../../reference/org/api";
import { RosterScope } from "./roster-scope";

beforeAll(() => loadCatalog("ko"));

test.each(["TENANT", "LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT", "pending", "none"])("facet availability is known before its reads: %s", async kind => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  if (kind !== "pending") await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries: kind === "none" ? [] : [
    { grant_id: "org", domain: "org", level: "view", enforcement: "ENFORCED", scope: { kind } },
  ] }) });
  const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><RosterScope onChange={() => {}} /></QueryClientProvider>);
  try {
    const first = render();
    await client.fetchQuery({ ...entitiesRef, queryFn: async () => ({ items: [] }) });
    await client.fetchQuery({ ...orgStructureRef, queryFn: async () => ({ entities: [] }) });
    await client.fetchQuery({ ...unitsQuery, queryFn: async () => ({ items: [] }) });
    const loaded = render();
    const allowed = ["TENANT", "LEGAL_ENTITY", "WORKPLACE"].includes(kind);
    expect(first.includes('aria-label="범위 · 전체 · 변경"')).toBe(allowed);
    expect(loaded.includes('aria-label="범위 · 전체 · 변경"')).toBe(allowed);
    expect(first).not.toContain('data-tone="warn"');
    expect(loaded).not.toContain('data-tone="warn"');
  } finally { client.clear(); }
});
