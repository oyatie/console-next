// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { MAX_RETRY_AFTER_MS } from "../../../lib/react/query-defaults";
import { myAccessQuery } from "../../../reference/authz/api";
import { modulesQuery } from "../api";
import { GoLive } from "./go-live";

const state = vi.hoisted(() => ({
  nav: vi.fn(), refetch: vi.fn<() => Promise<void>>(), setQueriesData: vi.fn(),
  success: undefined as unknown as (result: { phase: string; go_live_at: string }) => void | Promise<void>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ refetchQueries: state.refetch, setQueriesData: state.setQueriesData }),
  useQuery: () => ({ isPending: true, isFetching: false, isFetchedAfterMount: false }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.nav, Link: () => null }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (options: { onSuccess: typeof state.success }) => {
  state.success = options.onSuccess;
  return { isPending: false };
} }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const result = { phase: "OPERATING", go_live_at: "2026-10-26T09:00:00Z" };

test("go-live joins both destination reads before navigating", async () => {
  const access = Promise.withResolvers<void>(), modules = Promise.withResolvers<void>();
  state.refetch.mockReturnValueOnce(access.promise).mockReturnValueOnce(modules.promise);
  renderToStaticMarkup(<GoLive />);
  const done = state.success(result);
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
  const done = state.success(result);
  expect(state.nav).not.toHaveBeenCalled();
  if (failure === "error") held.reject(new TypeError("unavailable"));
  else await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS);
  await done;
  expect(state.nav).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  expect(vi.getTimerCount()).toBe(0);
  held.resolve();
});
