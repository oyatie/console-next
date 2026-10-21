import { expect, test } from "vitest";
import { loopProblems } from "./check-loops.mjs";

test("timers and polling options fail; explicit opt-outs pass", () => {
  const src = [
    "useQuery({ ...q, refetchInterval: false, refetchOnWindowFocus: false });",
    "const id = setInterval(() => qc.invalidateQueries(), 30_000);",
    "useQuery({ ...q, refetchInterval: 15_000 });",
    "new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, refetchIntervalInBackground: true } } });",
    "useQuery({ ...q, refetchInterval });",
    "window.setInterval (tick, 1000);",
  ].join("\n");
  expect(loopProblems("a.ts", src).map((p) => p.split(";")[0])).toEqual([
    "a.ts:2: setInterval re-reads on a timer",
    "a.ts:6: setInterval re-reads on a timer",
    "a.ts:3: refetchInterval polls",
    "a.ts:4: refetchInterval polls",
    "a.ts:5: refetchInterval polls",
    "a.ts:4: refetchOnWindowFocus re-reads on every focus",
  ]);
});

test("a file without loops passes", () => {
  expect(loopProblems("b.ts", "setTimeout(done, 300); useQuery({ ...q, staleTime: 30_000 });")).toEqual([]);
});
