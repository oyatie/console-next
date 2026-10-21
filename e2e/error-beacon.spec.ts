import { expect, test, type Page } from "@playwright/test";

// B-01: a white screen, from any cause, reaches our own origin as a beacon (POST /api/v1/client-errors) instead of
// being invisible to every alert (2026-10-08: the owner was the monitor). The payload is the kind, the build, the
// route pattern and the error's constructor name: never its message, the query string or the hash.
// The entry is matched in both shapes: Vite dev serves sources, a build serves hashed assets.
const ENTRY = /^\/(src\/main\.tsx|assets\/index-[\w-]+\.js)$/;
const served = process.env.E2E_SERVED === "1";
type Beacon = { kind: string; build: string; route: string; name?: string };

/** Every beacon the page posts, parsed. */
function beacons(page: Page) {
  const got: Beacon[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/client-errors") got.push(JSON.parse(r.postData() ?? "null") as Beacon);
  });
  return got;
}
const kinds = (got: Beacon[]) => () => got.map((b) => b.kind);
const expectBuild = (b: Beacon) => (served ? expect(b.build).toMatch(/^[A-Za-z0-9_-]{1,16}$/) : expect(b.build).toBe("dev"));

test("an uncaught error and an unhandled rejection are reported by kind and name, without their text", async ({ page }) => {
  const got = beacons(page);
  await page.goto("/login?next=secret-query#secret-hash");
  await expect(page.getByRole("button", { name: "패스키로 로그인" })).toBeVisible();
  await page.evaluate(() => {
    setTimeout(() => {
      throw new TypeError("홍길동 010-1234-5678 secret-message");
    });
    void Promise.reject(new RangeError("secret-reason"));
  });
  await expect.poll(kinds(got)).toEqual(expect.arrayContaining(["error", "rejection"]));
  const error = got.find((b) => b.kind === "error")!;
  expect(error).toMatchObject({ route: "/login", name: "TypeError" });
  expectBuild(error);
  expect(got.find((b) => b.kind === "rejection")).toMatchObject({ route: "/login", name: "RangeError" });
  expect(JSON.stringify(got)).not.toMatch(/secret|홍길동|010/);
  expect(Object.keys(error).sort()).toEqual(["build", "kind", "name", "route"]);
});

test("an entry chunk that is gone is reported as a resource failure", async ({ page }) => {
  const got = beacons(page);
  await page.route((u) => ENTRY.test(u.pathname), (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/login");
  await expect.poll(kinds(got)).toContain("resource");
  expect(got.find((b) => b.kind === "resource")).toMatchObject({ route: "/login" });
});

test("an app that never renders is reported by the boot watchdog after 15 s", async ({ page }) => {
  const got = beacons(page);
  await page.clock.install();
  // The entry loads but renders nothing (no error either): only the watchdog can see it.
  await page.route((u) => ENTRY.test(u.pathname), (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto("/login");
  await page.clock.fastForward(14_000);
  expect(got).toHaveLength(0);
  await page.clock.fastForward(2_000);
  await expect.poll(kinds(got)).toEqual(["boot"]);
  expect(got[0]).toMatchObject({ route: "/login" });
});

test("an app that renders sends nothing", async ({ page }) => {
  const got = beacons(page);
  await page.clock.install();
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "패스키로 로그인" })).toBeVisible();
  await page.clock.fastForward(20_000);
  await page.waitForTimeout(500);
  expect(got).toEqual([]);
});
