// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, configure, session } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { queryDefaults } from "../lib/react/query-defaults";
import { SessionRecovery } from "./session-recovery";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), invalidate: vi.fn(), options: [] as Parameters<QueryClient["fetchQuery"]>[0][], error: null as unknown }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("../lib/react/use-online", () => ({ useOnline: () => true }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: Parameters<QueryClient["fetchQuery"]>[0]) => {
    mocks.options.push(options);
    return { isPending: !mocks.error, error: mocks.error, data: undefined };
  },
}));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { session.set(null); mocks.options = []; mocks.error = null; vi.clearAllMocks(); vi.unstubAllGlobals(); });

test("cold restore has one attempt per manual retry and a definitive 401 goes to login", async () => {
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "service_unavailable" } }), { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const content = "protected";
  const html = renderToStaticMarkup(<SessionRecovery><p>{content}</p></SessionRecovery>);
  expect(html).toContain(t("common.loading"));
  expect(html).toContain('data-read-layout="list"');
  expect(html).not.toContain("protected");
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults, retryDelay: 0 } } });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(client.fetchQuery(mocks.options[0]!)).rejects.toBeInstanceOf(ApiError);
      expect(fetch).toHaveBeenCalledTimes(attempt);
      expect(mocks.navigate).not.toHaveBeenCalled();
    }
    fetch.mockImplementation(async () => new Response("{}", { status: 401 }));
    await client.fetchQuery(mocks.options[0]!);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/login" });
  } finally { client.clear(); }
});

test("a failed cold restore names the session and offers retry", () => {
  mocks.error = new ApiError(503, "service_unavailable", "upstream unavailable");
  const content = "protected";
  const html = renderToStaticMarkup(<SessionRecovery><p>{content}</p></SessionRecovery>);
  expect(html).toContain(t("common.read.sessionRestoreReason"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain("protected");
});

test("a restored session leaves consent enforcement to the route guard", () => {
  session.set({ access_token: `h.${btoa(JSON.stringify({ sub: "u", org: "o" }))}.s`, token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const content = "protected";
  const html = renderToStaticMarkup(<SessionRecovery><p>{content}</p></SessionRecovery>);
  expect(html).toContain(content);
  expect(mocks.options).toHaveLength(1);
  expect(mocks.options[0]).toMatchObject({ enabled: false });
});
