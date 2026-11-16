// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { MAX_RETRY_AFTER_MS } from "../../../lib/react/query-defaults";
import { myAccessQuery } from "../../../reference/authz/api";
import { goLive, modulesQuery } from "../api";
import { GoLive } from "./go-live";

const state = vi.hoisted(() => ({
  nav: vi.fn(), refetch: vi.fn<() => Promise<void>>(), setQueriesData: vi.fn(),
  router: { state: { location: { href: "/setup/go-live" } } },
  run: undefined as unknown as (input: undefined, key: string) => ReturnType<typeof goLive>,
  success: undefined as unknown as (result: { phase: string; go_live_at: string }) => void | Promise<void>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ refetchQueries: state.refetch, setQueriesData: state.setQueriesData }),
  useQuery: () => ({ data: { digest: "preview", line_digests: {} }, isPending: true, isFetching: false, isFetchedAfterMount: true }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.nav, useRouter: () => state.router, Link: () => null }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: () => null }));
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), goLive: vi.fn() }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (options: { run: typeof state.run; onSuccess: typeof state.success }) => {
  state.run = options.run;
  state.success = options.onSuccess;
  return { isPending: false };
} }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const result = { phase: "OPERATING" as const, go_live_at: "2026-10-26T09:00:00Z" };
beforeEach(() => {
  state.router.state.location = { href: "/setup/go-live" };
  vi.mocked(goLive).mockResolvedValue({ ...result, notified: 1 });
});
const submit = async () => {
  const out = await state.run(undefined, "intent");
  await state.success(out);
  return out;
};

test("go-live joins both destination reads before navigating", async () => {
  const access = Promise.withResolvers<void>(), modules = Promise.withResolvers<void>();
  state.refetch.mockReturnValueOnce(access.promise).mockReturnValueOnce(modules.promise);
  renderToStaticMarkup(<GoLive />);
  const done = submit();
  await vi.waitFor(() => expect(state.refetch).toHaveBeenCalledTimes(2));
  expect(state.refetch.mock.calls).toEqual([
    [myAccessQuery, { cancelRefetch: false }],
    [modulesQuery, { cancelRefetch: false }],
  ]);
  expect(state.nav).not.toHaveBeenCalled();
  modules.resolve();
  await Promise.resolve();
  expect(state.nav).not.toHaveBeenCalled();
  access.resolve();
  await done;
  expect(state.nav).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});

test.each(["timeout", "error"])("go-live navigates after a destination read %s", async failure => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<void>();
  state.refetch.mockReturnValue(held.promise);
  renderToStaticMarkup(<GoLive />);
  const done = submit();
  await vi.waitFor(() => expect(state.refetch).toHaveBeenCalled());
  expect(state.nav).not.toHaveBeenCalled();
  if (failure === "error") held.reject(new TypeError("unavailable"));
  else await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS);
  await done;
  expect(state.nav).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  expect(vi.getTimerCount()).toBe(0);
  held.resolve();
});

test("go-live owns the readiness wait and returns the server answer before its navigation callback", async () => {
  const held = Promise.withResolvers<void>();
  state.refetch.mockReturnValue(held.promise);
  renderToStaticMarkup(<GoLive />);
  let finished = false;
  const done = state.run(undefined, "intent").then(out => { finished = true; return out; });
  try {
    await vi.waitFor(() => expect(state.setQueriesData).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(state.refetch).toHaveBeenCalledTimes(2);
    held.resolve();
    await expect(done).resolves.toEqual({ ...result, notified: 1 });
    expect(state.nav).not.toHaveBeenCalled();
  } finally { held.resolve(); await done; }
});

test.each(["/org", "/setup/go-live?tab=receipt", "/setup/go-live"])("a navigation to %s during readiness wins over go-live's redirect", async href => {
  const held = Promise.withResolvers<void>();
  state.refetch.mockReturnValue(held.promise);
  renderToStaticMarkup(<GoLive />);
  const done = submit();
  await vi.waitFor(() => expect(state.refetch).toHaveBeenCalled());
  state.router.state.location = { href };
  held.resolve();
  await done;
  expect(state.nav).not.toHaveBeenCalled();
});
