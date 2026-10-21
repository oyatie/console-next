import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { termsQuery } from "../api";

test("opening terms re-reads a recently cached document before allowing its acceptance", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
  const old = { version: "v1", sha256: "a".repeat(64), body: "Old document" };
  const latest = { version: "v2", sha256: "b".repeat(64), body: "New document" };
  await client.fetchQuery({ ...termsQuery, staleTime: 60_000, queryFn: async () => old });
  const queryFn = vi.fn(async () => latest);
  const options = { ...termsQuery, queryFn, enabled: false };
  const observer = new QueryObserver(client, options);
  const stop = observer.subscribe(() => undefined);
  try {
    observer.setOptions({ ...options, enabled: true });
    expect(observer.getCurrentResult().isFetching).toBe(true);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(latest));
    expect(queryFn).toHaveBeenCalledOnce();
  } finally {
    stop(); client.clear();
  }
});
