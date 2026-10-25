// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- The router mock preserves the rendered link's accessible name.
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import type { AccessGrant } from "../api";
import { GrantsPage } from "./grants-page";
import { ReadinessPage } from "./readiness-page";

const state = vi.hoisted(() => ({ grants: [] as AccessGrant[], linked: false }));
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: () => ({ data: { items: state.grants }, isPending: false, isError: false }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, params, search: _search, ...props }: { children: ReactNode; to: string; params?: Record<string, string>; search?: unknown }) => <a {...props} href={to.replace(/\$([A-Za-z]+)/g, (_, key: string) => params?.[key] ?? "")}>{children}</a> }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({
  accounts: [
    { id: "a", display_name: "Namesake", sign_in_id: "worker1234@example.test", is_active: true, has_passkey: true },
    { id: "b", display_name: "Namesake", sign_in_id: "worker5678@example.test", is_active: true, has_passkey: true },
  ].map((a, i) => ({ ...a, ...(state.linked && { employee_id: `person-${i}`, employee_number: `E-${i}` }) })),
  cat: {}, accountsQ: { isFetching: false },
  ops: "ops", roles: [], setup: true,
  q: { data: true, isPending: false, error: null },
}) }));
vi.mock("./use-org-roots", () => ({ useOrgRoots: () => [] }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
vi.mock("./access-requests", () => ({ AccessRequests: () => null }));
vi.mock("./grant-change", () => ({ GrantChange: () => null }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.grants = []; state.linked = false; });

test("each readiness grant link names its person with the visible disambiguator", () => {
  const html = renderToStaticMarkup(<ReadinessPage />);
  const names = [...html.matchAll(/<a\b[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  expect(names).toEqual(["1234", "5678"].map((suffix) => t("people.label.grant", { name: `Namesake · w••••${suffix}@example.test` })));
  expect(new Set(names).size).toBe(2);
});

test.each([["readiness", ReadinessPage], ["grants", GrantsPage]] as const)("%s rows retain separate, uniquely named person-card links for employee namesakes", (_name, Page) => {
  state.linked = true;
  state.grants = ["a", "b"].map((account_id, i) => ({
    id: `g-${i}`, account_id, account_display_name: "Namesake", account_active: true, account_has_passkey: true,
    role_id: "r", role_name_ko: "Reader", scope: { kind: "TENANT", include_descendants: true },
    valid_from: "2026-10-01T00:00:00Z", enforcement: "PREPARED", effective_in_setup: false,
    reason_code: "OTHER", granted_by: "ops", granted_at: "2026-10-01T00:00:00Z",
  }));
  const html = renderToStaticMarkup(<Page />);
  for (const i of [0, 1]) {
    const name = t("people.label.record", { name: `Namesake · E-${i}` });
    expect(html).toContain(`aria-label="${name}" href="/people/person-${i}"`);
    expect(html).toContain(`href="/access/people/${i === 0 ? "a" : "b"}"`);
  }
  expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
});
