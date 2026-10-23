import { expect, test, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiError } from "@console/api";
import { queryDefaults } from "./react/query-defaults";
import { freshOnOpen, get, invalidatePaths, read, readIdentity, underPath } from "./query";

test("a path prefix covers the path and everything under it, not a sibling that shares its text", () => {
  const employees = underPath("/api/v1/employees");
  expect(employees(["/api/v1/employees", { query: { limit: 1 } }])).toBe(true);
  expect(employees(["/api/v1/employees/{id}", { path: { id: "e1" } }])).toBe(true);
  expect(employees(["/api/v1/employees/{id}/lifecycle-events", null])).toBe(true);
  expect(employees(["/api/v1/employees-import", null])).toBe(false);
  expect(employees(["/api/v1/directory/people", null])).toBe(false);
  expect(employees(["employees"])).toBe(false);
});

test("read identity follows date coordinates without depending on descriptor object identity", () => {
  const at = (as_of: string, known_at?: string) => get("/api/v1/org-structure", { params: { query: { as_of, known_at } } });
  expect(readIdentity(at("2026-10-09"))).toBe(readIdentity(at("2026-10-09")));
  expect(readIdentity(at("2026-10-09"))).not.toBe(readIdentity(at("2026-09-09")));
  expect(readIdentity(at("2026-10-09"))).not.toBe(readIdentity(at("2026-10-09", "2026-09-15")));
});

test("a cached refusal settles arrival without asking the refused read again", async () => {
  let reads = 0;
  const client = new QueryClient({ defaultOptions: { queries: queryDefaults } });
  const descriptor = { ...get("/api/v1/onboarding/checklist"), queryFn: async () => {
    reads++;
    throw new ApiError(403, "forbidden", "forbidden");
  }, refetchOnMount: "always" as const };
  await client.fetchQuery(descriptor).catch(() => undefined);
  const observer = new QueryObserver(client, descriptor);
  const unsubscribe = observer.subscribe(() => undefined);
  const arrival = freshOnOpen(observer.getCurrentResult());
  expect(arrival.isPending).toBe(false);
  expect(arrival.error).toMatchObject({ status: 403 });
  expect(reads).toBe(1);
  unsubscribe();
  client.clear();
});

test("regression (row editor closing on the old row): a read under two prefixes is re-read once, and the first prefix's promise waits for it", async () => {
  const qc = new QueryClient();
  let fetches = 0;
  let land = () => {};
  const rowsRead = read("/api/v1/employees/{id}/register-facts", () => (fetches++, fetches === 1 ? Promise.resolve("old") : new Promise<string>((r) => (land = () => r("new")))));
  const observer = new QueryObserver(qc, rowsRead);
  const off = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe("old"));
  const [rows, rest] = invalidatePaths(qc, ["/api/v1/employees/{id}/register-facts", "/api/v1/employees"]);
  await rest;
  let settled = false;
  void rows!.then(() => (settled = true));
  await Promise.resolve();
  expect(settled, "the rows' read has not landed yet").toBe(false);
  land();
  await rows;
  expect(observer.getCurrentResult().data).toBe("new");
  expect(fetches, "one re-read, not a second that cancels the first").toBe(2);
  off();
});

test("wrapped reads keep different run parameters in separate cache entries", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const at = (id: string) => read("/api/v1/employee-import-runs/{run_id}/rollback/preview", async () => id, { path: { run_id: id } });
  expect(await client.fetchQuery(at("first"))).toBe("first");
  expect(await client.fetchQuery(at("second"))).toBe("second");
  expect(readIdentity(at("first"))).not.toBe(readIdentity(at("second")));
});
