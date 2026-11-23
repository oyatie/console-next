// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useRosterScreen } from "./use-roster-screen";

const state = vi.hoisted(() => ({ search: {} as Record<string, string>, navigate: vi.fn(), read: vi.fn(), windowFailed: false }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => state.navigate }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined, isError: state.windowFailed, isPending: false }) }));
vi.mock("../../../lib/react/prefetch", () => ({ usePrefetch: () => vi.fn() }));
vi.mock("../../../lib/react/announce", () => ({ focusSoon: vi.fn() }));
vi.mock("../../../lib/reason-codes", () => ({ useReasonCodesReady: () => false }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));
vi.mock("./use-roster-columns", () => ({ useRosterColumns: () => ({ shown: [], density: "compact" }) }));
vi.mock("./use-roster", () => ({ useRoster: (...args: unknown[]) => {
  state.read(...args);
  return { rows: [], total: 0, loading: false };
} }));

function Fixture({ onRead }: { onRead: (screen: ReturnType<typeof useRosterScreen>) => void }) {
  onRead(useRosterScreen());
  return null;
}
const render = () => {
  let screen!: ReturnType<typeof useRosterScreen>;
  renderToStaticMarkup(<Fixture onRead={value => { screen = value; }} />);
  return screen;
};
beforeEach(() => { state.search = {}; state.windowFailed = false; vi.clearAllMocks(); });

test("the screen starts with the current roster and no selection or search", () => {
  const screen = render();
  expect(screen).toMatchObject({ status: "current", review: [], q: "", open: undefined, openUnit: undefined, full: false, filtered: false, customFilters: false });
  expect(state.read).toHaveBeenCalledWith({ status: "current", review: [], unit: undefined, q: "", sort: "name" }, undefined, true);
});

test("URL filters and both selected panes reach the screen without changing the search", () => {
  state.search = { status: "EXITED", review: "identity", unit: "department", sort: "hire_date", sel: "person", sel2: "department", full: "1" };
  const screen = render();
  expect(screen).toMatchObject({ status: "EXITED", review: ["identity"], unit: "department", sort: "hire_date", open: "person", openUnit: "department", full: true, q: "", filtered: true, customFilters: true });
  expect(state.navigate).not.toHaveBeenCalled();
});

test("changing a filter closes both panes and keeps unrelated URL state", () => {
  state.search = { sel: "person", sel2: "department", export: "register", sort: "hire_date" };
  const screen = render();
  screen.setFilter({ status: "current", review: [], unit: null });
  const navigation = state.navigate.mock.calls[0]![0];
  expect(navigation.replace).toBe(true);
  expect(navigation.search(state.search)).toEqual({ sel: undefined, sel2: undefined, export: "register", sort: "hire_date", status: undefined, review: undefined, unit: undefined });
});

test("a settings failure keeps the roster read enabled without a stale contract window", () => {
  state.windowFailed = true;
  const screen = render();
  expect(screen.soonDays).toBeUndefined();
  expect(state.read).toHaveBeenCalledWith(expect.anything(), undefined, true);
});

test("URL ids filter exposes ids, marks filtered/customFilters, and clears ids on reset", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  state.search = { ids: id };
  const screen = render();
  expect(screen).toMatchObject({ ids: [id], filtered: true, customFilters: true });
  screen.reset();
  const navigation = state.navigate.mock.calls.at(-1)![0];
  expect(navigation.search(state.search)).toMatchObject({ ids: undefined, status: undefined, unit: undefined });
});
