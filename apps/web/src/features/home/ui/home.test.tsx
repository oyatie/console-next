// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { Home } from "../Home";

const state = vi.hoisted(() => ({ caps: [] as object[], reads: [] as string[] }));
vi.mock("../../../lib/query", async (original) => {
  const actual = await original<typeof import("../../../lib/query")>();
  return { ...actual, get: (path: Parameters<typeof actual.get>[0], init?: Parameters<typeof actual.get>[1]) => {
    state.reads.push(path);
    return { ...actual.get(path, init), ...(path === "/api/v1/me/authz" ? { initialData: () => ({ capabilities: state.caps }) } : {}) };
  } };
});

test.each([
  { feature: "legal_entity_manage", org_wide: true },
  { feature: "org_change_apply", org_wide: true },
  { feature: "org_change_apply", org_wide: false },
  { feature: "legal_entity_manage", org_wide: false },
  { feature: "org_change_read", org_wide: true },
])("Home leaves correction ownership to the unified inbox for $feature org_wide=$org_wide", ({ feature, org_wide }) => {
  const client = new QueryClient();
  state.caps = [{ feature, org_wide, permission: "allow", scoped: !org_wide }];
  state.reads = [];
  renderToStaticMarkup(<QueryClientProvider client={client}><Home setupPending /></QueryClientProvider>);
  expect(state.reads).not.toContain("/api/v1/entity-identifier-corrections");
});
