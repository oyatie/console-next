// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { EntityList } from "./entity-list";

const state = vi.hoisted(() => ({ loaded: false, failed: false }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => queryKey[0] === "/api/v1/legal-entities"
    ? { data: state.loaded ? { items: [] } : undefined, isPending: !state.loaded && !state.failed, error: state.failed ? new Error("unavailable") : null }
    : { data: { phase: "OPERATING" } },
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("./correction-register", () => ({ CorrectionRegister: () => <section data-testid="correction-register" /> }));
vi.mock("./entity-quick-add", () => ({ QuickAdd: () => null }));
vi.mock("./unattached-workplaces", () => ({ UnattachedWorkplaces: () => null }));
vi.mock("./asof-band", () => ({ AsOfBand: () => null }));

beforeAll(() => loadCatalog("ko"));

test("correction controls wait for the entity list above them to finish its first read", () => {
  state.loaded = false;
  state.failed = false;
  expect(renderToStaticMarkup(<EntityList />)).not.toContain('data-testid="correction-register"');
  state.loaded = true;
  expect(renderToStaticMarkup(<EntityList />)).toContain('data-testid="correction-register"');
  state.loaded = false;
  state.failed = true;
  expect(renderToStaticMarkup(<EntityList />)).toContain('data-testid="correction-register"');
});
