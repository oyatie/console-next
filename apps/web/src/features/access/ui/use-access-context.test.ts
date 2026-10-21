import { afterEach, expect, test, vi } from "vitest";
import { useAccessContext } from "./use-access-context";

const state = vi.hoisted(() => ({ fetched: false, success: true, items: [] as { id: string }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { items: state.items }, isFetchedAfterMount: state.fetched, isSuccess: state.success }),
}));
afterEach(() => { state.fetched = false; state.success = true; state.items = []; });

test("a cached empty roles list cannot open a grant sheet before the arrival read", () => {
  expect(useAccessContext().rolesLoaded).toBe(false);
  state.fetched = true;
  state.items = [{ id: "new-role" }];
  expect(useAccessContext().rolesLoaded).toBe(true);
  expect(useAccessContext().roles).toEqual([{ id: "new-role" }]);
});

test("a confirmed empty list can open the sheet, but a failed arrival cannot", () => {
  state.fetched = true;
  expect(useAccessContext().rolesLoaded).toBe(true);
  state.success = false;
  expect(useAccessContext().rolesLoaded).toBe(false);
});
