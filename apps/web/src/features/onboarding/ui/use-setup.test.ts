import { expect, test, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { useSetupChecklist } from "./use-setup";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));

const cached = { phase: "SETUP", steps: [{ key: "workplace", state: "blocked" }] };
const answer = (over = {}) => vi.mocked(useQuery).mockReturnValue({
  data: cached, isSuccess: true, isError: false, isFetchedAfterMount: false, ...over,
} as ReturnType<typeof useQuery>);

test("Home holds cached checklist actions until its arrival read, then keeps them during background reads", () => {
  answer();
  expect(useSetupChecklist()).toMatchObject({ loaded: false, checklist: undefined });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ refetchOnMount: "always" }));

  const current = { ...cached, steps: [{ key: "workplace", state: "done" }] };
  answer({ data: current, isFetchedAfterMount: true });
  expect(useSetupChecklist()).toMatchObject({ loaded: true, checklist: current });
  answer({ data: current, isFetchedAfterMount: true, isFetching: true });
  expect(useSetupChecklist()).toMatchObject({ loaded: true, checklist: current });
});

test("an arrival read failure settles Home without inventing setup steps", () => {
  answer({ data: undefined, isSuccess: false, isError: true, isFetchedAfterMount: true });
  expect(useSetupChecklist()).toEqual({ loaded: true, served: false, checklist: undefined });
});
