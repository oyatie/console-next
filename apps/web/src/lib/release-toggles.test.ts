import { afterEach, expect, test, vi } from "vitest";

/** A fresh module (it reads the list once, on import) over a stubbed fetch. */
async function load(fetch: () => Promise<Response>) {
  vi.resetModules();
  const stub = vi.fn(fetch);
  vi.stubGlobal("fetch", stub);
  const m = await import("./release-toggles");
  await m.releaseTogglesRead;
  return { ...m, calls: stub.mock.calls as unknown[][] };
}
afterEach(() => vi.unstubAllGlobals());

test("a listed toggle is released; anything else is not; the list is read once, without credentials", async () => {
  const m = await load(async () => Response.json({ enabled: ["new-payslip", 7] }));
  expect(m.released("new-payslip")).toBe(true);
  expect(m.released("other")).toBe(false);
  expect(m.calls).toEqual([["/api/v1/release-toggles", { credentials: "omit" }]]);
  m.released("new-payslip");
  expect(m.calls).toHaveLength(1);
});

test("every failure leaves every toggle off: a 404 (an older server), garbage, a network fault", async () => {
  for (const fetch of [
    async () => Response.json({ enabled: ["x"] }, { status: 404 }),
    async () => new Response("not json"),
    async () => Response.json({ enabled: "x" }),
    async () => Promise.reject(new TypeError("Failed to fetch")),
  ])
    expect((await load(fetch)).released("x")).toBe(false);
});
