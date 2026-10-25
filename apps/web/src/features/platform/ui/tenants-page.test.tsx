// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { TenantsPage } from "./tenants-page";
import type { Org } from "../api";

const state = vi.hoisted(() => ({ search: {} as { q?: string; sel?: string }, tenants: [] as unknown[], reads: 0, navigate: vi.fn() }));
// Base-worktree runs share node_modules; load this checkout's catalogs instead of its workspace symlink.
vi.mock("@console/i18n", async () => await import("../../../../../../packages/i18n/src/index"));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => state.navigate }) }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ isSuccess: true, isPending: false, isFetching: false, data: state.reads++ === 0 ? state.tenants : { tenants: [] } }),
}));
vi.mock("../../../reference/authz/ui/access-gate", () => ({ PageReadGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ children }: { children: () => ReactNode }) => children() }));
vi.mock("../../../lib/react/support-lookup", () => ({ SupportLookup: () => null }));
vi.mock("./key-notices", () => ({ KeyNotices: () => null }));
vi.mock("./onboard-form", () => ({ OnboardDialog: () => null }));
vi.mock("./code-dialog", () => ({ CodeDialog: () => null }));
vi.mock("./tenant-panel", () => ({ TenantPanel: () => <aside data-tenant-panel /> }));

beforeAll(async () => {
  await Promise.all([loadCatalog("ko"), loadCatalog("en")]);
  state.tenants = [
    { id: "platform", name: "Vendor", slug: "platform", status: "ACTIVE" },
    { id: "alpha", name: "Alpha", slug: "alpha", status: "ACTIVE" },
    { id: "beta", name: "Beta", slug: "beta", status: "ACTIVE" },
    { id: "gamma", name: "Gamma", slug: "gamma", status: "SUSPENDED" },
    { id: "delta", name: "Delta", slug: "delta", status: "ARCHIVED" },
  ].map((org) => ({ ...org, group_name: null, created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" }) as Org);
});

const render = (locale: "ko" | "en", search: typeof state.search) => {
  i18n.set(locale);
  state.search = search;
  state.reads = 0;
  return renderToStaticMarkup(<TenantsPage />);
};

test.each(["ko", "en"] as const)("%s status tab totals stay global while the rows are searched", (locale) => {
  const html = render(locale, { q: "Alpha" });
  for (const [view, n] of [["active", 2], ["suspended", 1], ["archived", 1], ["all", 4]] as const) {
    expect(html).toContain(`>${t(`tenants.view.${view}`, { n })}</button>`);
  }
  expect(html).toContain('data-id="alpha"');
  expect(html).not.toContain('data-id="beta"');
});

test.each(["ko", "en"] as const)("%s list reserves no panel until a customer account is selected", (locale) => {
  const html = render(locale, {});
  expect(html).not.toContain("<aside");
  expect(render(locale, { sel: "alpha" })).toContain("data-tenant-panel");
});

test.each(["ko", "en"] as const)("%s search has a visible label and no-match reset action", (locale) => {
  const html = render(locale, { q: "missing-customer" });
  const label = html.match(/<label\b[^>]*for="([^"]+)"[^>]*>([^<]*)<\/label>/);
  expect(label?.[2]).toBe(t("tenants.search"));
  expect(html).toContain(`id="${label?.[1]}"`);
  expect(html).toContain("“missing-customer”");
  expect(html).toContain(`>${t("tenants.search.reset")}</button>`);
});
