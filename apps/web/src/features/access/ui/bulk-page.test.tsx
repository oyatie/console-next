// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { BulkPage } from "./bulk-page";

const state = vi.hoisted(() => ({ pending: true }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { entities: [] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isPending: false, error: null }) }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({
  accounts: [], accountsQ: { data: state.pending ? undefined : { items: [] }, isPending: state.pending, error: null },
  cat: { data: {} }, roles: [], setup: true,
  q: { isPending: state.pending, data: state.pending ? undefined : true, error: null },
}) }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
vi.mock("./use-reasons", () => ({ useReasons: () => ({ codes: [] }) }));
beforeAll(() => loadCatalog("ko"));

test("the bulk form waits for its people list so a shrinking loading table cannot move it", () => {
  state.pending = true;
  const loading = renderToStaticMarkup(<BulkPage />);
  expect(loading.includes(t("access.bulk.what"))).toBe(false);
  expect(loading).toContain(t("common.loading"));
  state.pending = false;
  expect(renderToStaticMarkup(<BulkPage />)).toContain(t("access.bulk.what"));
});
