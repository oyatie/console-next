import { expect, test } from "vitest";
import { coverage } from "./coverage";

// regression (governance-16, governance-32): one refused read replaced the whole queue, and a failed one dropped
// its card silently; neither may read as "nothing to do".
test("names each refused and failed part once; the queue is complete only when every read landed", () => {
  const c = coverage([
    { key: "review", state: "ok" },
    { key: "review", state: "failed" },
    { key: "exits", state: "denied" },
    { key: "changes", state: "denied" },
    { key: "exits", state: "denied" },
  ]);
  expect(c).toEqual({ loading: false, denied: ["exits", "changes"], failed: ["review"], complete: false });
  expect(coverage([{ key: "exits", state: "ok" }]).complete).toBe(true);
  expect(coverage([{ key: "exits", state: "loading" }])).toMatchObject({ loading: true, complete: true });
  expect(coverage([]).complete).toBe(true);
});
