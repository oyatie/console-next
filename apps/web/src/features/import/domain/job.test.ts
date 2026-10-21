import { expect, test } from "vitest";
import { keepJob, keptJob, running, share } from "./job";
import type { ApplyJob } from "./contract";

const job = (state: ApplyJob["state"], done: number, total: number) => ({ run_id: "r", state, dry_run_digest: "d", requested_by: "u", done, total }) as ApplyJob;

test("a kept job comes back as kept; a broken entry or a throwing store is no job", () => {
  const m = new Map<string, string>();
  const store = () => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  keepJob({ runId: "r1", digest: "abc" }, store);
  expect(keptJob(store)).toEqual({ runId: "r1", digest: "abc" });
  m.set("console.import.applyJob", "{");
  expect(keptJob(store)).toBeNull();
  keepJob(null, store);
  expect(keptJob(store)).toBeNull();
  const broken = () => { throw new Error("no storage"); };
  expect(() => keepJob({ runId: "r", digest: "d" }, broken)).not.toThrow();
  expect(keptJob(broken)).toBeNull();
});

test("running and share follow the job's state and rows", () => {
  expect(["queued", "applying", "settling"].map((s) => running(job(s as ApplyJob["state"], 0, 0)))).toEqual([true, true, true]);
  expect(running(job("done", 5, 5)) || running(job("failed", 0, 5))).toBe(false);
  expect(share(job("settling", 50, 200))).toBe(0.25);
  expect(share(job("applying", 0, 0))).toBe(0);
  expect(share(job("done", 0, 0))).toBe(1);
});
