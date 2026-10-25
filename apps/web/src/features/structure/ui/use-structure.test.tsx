// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useStructure } from "./use-structure";
const { entityRead } = vi.hoisted(() => ({ entityRead: { data: undefined as unknown, isPending: true, isPlaceholderData: false, error: null, refetch: vi.fn() } }));
vi.mock("../../../lib/react/arrival", () => ({ useFreshOnArrival: (q: unknown) => q }));
vi.mock("../../../lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/query")>();
  return { ...actual, get: (...args: Parameters<typeof actual.get>) => ({ ...actual.get(...args), path: args[0] }) };
});
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: (d: unknown) => d,
  useQuery: (q: { path?: string }) => q.path === "/api/v1/legal-entities" ? entityRead : q.path === "/api/v1/org-structure" ? { data: { tenant_name: "T", phase: "SETUP", entities: [], unplaced: [] }, isPending: false, error: null, refetch: vi.fn() } : { data: undefined },
}));
test("the structure never paints final cards before the entity identity read arrives", () => {
  function Probe() {
    const { s } = useStructure();
    return <span>{s ? "final cards" : "loading"}</span>;
  }
  expect(renderToStaticMarkup(<Probe />)).toContain("loading");
  entityRead.data = { items: [] };
  entityRead.isPending = false;
  expect(renderToStaticMarkup(<Probe />)).toContain("final cards");
});

beforeEach(() => { entityRead.data = undefined; entityRead.isPending = true; entityRead.isPlaceholderData = false; });
test("a new dated tree cannot paint with the previous date's entity facts", () => {
  entityRead.data = { items: [] };
  entityRead.isPending = false;
  entityRead.isPlaceholderData = true;
  function Probe() {
    const { s } = useStructure({ as_of: "2026-10-30" });
    return <span>{s ? "mixed dates" : "loading"}</span>;
  }
  expect(renderToStaticMarkup(<Probe />)).toContain("loading");
});
