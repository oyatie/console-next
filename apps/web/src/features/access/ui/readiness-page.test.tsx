// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- The router mock preserves the rendered link's accessible name.
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { ReadinessPage } from "./readiness-page";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [] }, isPending: false, isError: false }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a> }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({
  accounts: [
    { id: "a", display_name: "Namesake", sign_in_id: "worker1234@example.test", is_active: true, has_passkey: true },
    { id: "b", display_name: "Namesake", sign_in_id: "worker5678@example.test", is_active: true, has_passkey: true },
  ],
  ops: "ops", roles: [], setup: true,
}) }));
vi.mock("./use-org-roots", () => ({ useOrgRoots: () => [] }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
beforeAll(() => loadCatalog("ko"));

test("each readiness grant link names its person with the visible disambiguator", () => {
  const html = renderToStaticMarkup(<ReadinessPage />);
  const names = [...html.matchAll(/<a\b[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  expect(names).toEqual(["1234", "5678"].map((suffix) => t("people.label.grant", { name: `Namesake · w••••${suffix}@example.test` })));
  expect(new Set(names).size).toBe(2);
});
