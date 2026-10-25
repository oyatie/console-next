import { beforeEach, expect, test, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api";
import * as authz from "../../../reference/authz/api";
import { authzQuery } from "../../../reference/authz/api";
import { readIdentity } from "../../../lib/query";
import { useSetupChecklist } from "./use-setup";

vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: vi.fn() }));

const cached = { phase: "SETUP", steps: [{ key: "workplace", state: "blocked" }] };
let capabilities: { permission: string }[] | undefined;
const answer = (over = {}, access = {}) => vi.mocked(useQuery).mockImplementation((options) => (
  readIdentity(options) === readIdentity(authzQuery) ? { data: capabilities ? { capabilities } : undefined, isPending: capabilities === undefined, isError: false, ...access } : {
    data: cached, isSuccess: true, isError: false, isFetchedAfterMount: false, ...over,
  }
) as ReturnType<typeof useQuery>);
beforeEach(() => { vi.restoreAllMocks(); capabilities = [{ permission: "allow" }]; });

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

test("only the phase observer may use a placeholder; checklist actions still await the server", () => {
  const placeholder = { ...cached, go_live_at: null } as unknown as import("@console/api/pending").Checklist;
  answer({ data: placeholder, isPlaceholderData: true });
  const result = useSetupChecklist(placeholder);
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ placeholderData: placeholder }));
  expect(result.phaseQ.data).toBe(placeholder);
  expect(result.checklist).toBeUndefined();
  expect(result.q.isPending).toBe(true);
});

test("an arrival read failure settles Home without inventing setup steps", () => {
  answer({ data: undefined, isSuccess: false, isError: true, isFetchedAfterMount: true });
  expect(useSetupChecklist()).toMatchObject({ q: expect.objectContaining({ data: undefined }), loaded: true, served: false, checklist: undefined });
});

test("a checklist 403 suppresses cached setup actions", () => {
  answer({ isSuccess: false, isError: true, error: new ApiError(403, "forbidden", "refused"), isFetchedAfterMount: true });
  expect(useSetupChecklist().checklist).toBeUndefined();
});

test("a pending authz read keeps the checklist pending instead of claiming no work", () => {
  capabilities = undefined;
  answer({ isFetchedAfterMount: true });
  const result = useSetupChecklist();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  expect(result).toMatchObject({ checklist: undefined, loaded: false, q: { isPending: true } });
});

test.each([500, 503])("an authz %s still reads the server-enforced setup checklist", status => {
  capabilities = undefined;
  answer({ isFetchedAfterMount: true }, { isPending: false, isError: true, error: new ApiError(status, "internal", "unavailable") });
  expect(useSetupChecklist()).toMatchObject({ loaded: true, checklist: cached });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
});

test.each([{ caps: [] }, { caps: [{ permission: "request_only" }] }])("a successful authz read without a held grant skips the checklist: $caps", ({ caps }) => {
  capabilities = caps;
  answer({ isFetchedAfterMount: true });
  const result = useSetupChecklist();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  expect(result.checklist).toBeUndefined();
  expect(result.q.isPending).toBe(false);
});

test.each(["allow", "limited"])("a Cedar-projected %s grant enables the checklist", permission => {
  capabilities = [{ permission }];
  answer({ isFetchedAfterMount: true });
  expect(useSetupChecklist().checklist).toEqual(cached);
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
});

test("the first authz failure reads the checklist in parallel with retries", () => {
  capabilities = undefined;
  answer({ isFetchedAfterMount: true }, { failureCount: 1, isPending: true });
  expect(useSetupChecklist()).toMatchObject({ checklist: cached, loaded: true });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));

  capabilities = [];
  answer({ isFetchedAfterMount: true }, { failureCount: 0 });
  expect(useSetupChecklist().checklist).toBeUndefined();
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});

test("platform claims leave disabled authz and checklist reads settled", () => {
  vi.spyOn(authz, "authzApplies").mockReturnValue(false);
  capabilities = undefined;
  answer();
  expect(useSetupChecklist()).toMatchObject({ checklist: undefined, q: { isPending: false } });
  expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});
