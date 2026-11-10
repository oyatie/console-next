// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, configure, session } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { queryDefaults } from "../lib/react/query-defaults";
import { SessionRecovery } from "./session-recovery";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), invalidate: vi.fn(), options: [] as Parameters<QueryClient["fetchQuery"]>[0][], error: null as unknown, stream: true, wait: vi.fn(async () => {}) }));
vi.mock("../lib/live/session-stream", () => ({ streamReady: Object.assign(mocks.wait, { subscribe: vi.fn(), get: () => mocks.stream }) }));
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
afterEach(() => { session.set(null); mocks.options = []; mocks.error = null; mocks.stream = true; vi.clearAllMocks(); vi.unstubAllGlobals(); });

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

test("a token alone cannot mount protected children while the stream loads", () => {
  session.set({ access_token: `h.${btoa(JSON.stringify({ sub: "u", org: "o" }))}.s`, token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  mocks.stream = false;
  const content = "protected";
  const html = renderToStaticMarkup(<SessionRecovery><p>{content}</p></SessionRecovery>);
  expect(html).not.toContain("protected");
  expect(html).toContain(t("common.loading"));
});

test("cold restoration waits for the stream before invalidating routes", async () => {
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "h.e30.s" }))));
  const ready = Promise.withResolvers<void>();
  mocks.wait.mockReturnValueOnce(ready.promise);
  const content = "protected";
  renderToStaticMarkup(<SessionRecovery><p>{content}</p></SessionRecovery>);
  const client = new QueryClient();
  try {
    const restoring = client.fetchQuery(mocks.options[0]!);
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce());
    expect(mocks.invalidate).not.toHaveBeenCalled();
    ready.resolve();
    await restoring;
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  } finally { ready.resolve(); client.clear(); }
});

test("a lost session preserves mounted drafts while the stream is pending", () => {
  session.set({ access_token: `h.${btoa(JSON.stringify({ sub: "u", org: "o" }))}.s`, token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  session.expire();
  mocks.stream = false;
  const content = "protected draft";
  const html = renderToStaticMarkup(<SessionRecovery><p>{content}</p></SessionRecovery>);
  expect(html).toContain("protected draft");
  expect(mocks.options[0]).toMatchObject({ enabled: false });
});
