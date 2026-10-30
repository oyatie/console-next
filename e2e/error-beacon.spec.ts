import { loadCatalog, t } from "@console/i18n";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, vendorPage, unique, tenantSlugField } from "./flows";
import { expect, test, type Page } from "@playwright/test";

// B-01: a white screen, from any cause, reaches our own origin as a beacon (POST /api/v1/client-errors) instead of
// being invisible to every alert (2026-10-08: the owner was the monitor). The payload is the kind, the build, the
// route pattern and the error's constructor name: never its message, the query string or the hash.
// The entry is matched in both shapes: Vite dev serves sources, a build serves hashed assets.
const ENTRY = /^\/(src\/main\.tsx|assets\/index-[\w-]+\.js)$/;
test.beforeAll(() => loadCatalog("ko"));
const served = process.env.E2E_SERVED === "1";
type Beacon = { kind: string; release: string; build: string; route: string; name?: string };

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
  expect(error.release).toBe(error.build);
  expect(got.find((b) => b.kind === "rejection")).toMatchObject({ route: "/login", name: "RangeError" });
  expect(JSON.stringify(got)).not.toMatch(/secret|홍길동|010/);
  expect(Object.keys(error).sort()).toEqual(["build", "kind", "name", "release", "route"]);
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


test("a mutation 500 displays the same server reference that ops resolves to the trace", async ({ browser }) => {
  const page = await vendorPage(browser);
  try {
    await page.goto("/platform");
    await page.getByRole("button", { name: "고객 계정 개설" }).click();
    await page.getByLabel("고객 이름").fill(unique("지원참조회사"));
    await tenantSlugField(page).fill(unique("supportref"));
    let envelope: { support_ref: string; trace_id: string } | undefined;
    await page.route("**/api/platform/orgs", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({ url: new URL("/__e2e/support-reference-failure", route.request().url()).href });
      expect(response.status()).toBe(500);
      envelope = (await response.json()).error;
      return route.fulfill({ response });
    });
    await tenantOnboardSubmit(page).click();
    const panel = page.getByRole("dialog").getByRole("status").filter({ has: page.locator("[data-support-reference]") });
    await expect(panel).toContainText("지원 참조 번호");
    expect(envelope?.support_ref).toMatch(/^[0-9a-f]{32}$/);
    await expect(panel.locator("[data-support-reference]")).toHaveAttribute("data-support-reference", envelope!.support_ref);
    await expect(panel.getByText(envelope!.support_ref.slice(0, 8), { exact: true })).toBeVisible();
    await expectAccessible(page, "mutation 500 with support reference");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => { (window as Window & { copiedReference?: string }).copiedReference = value; return Promise.resolve(); } } }));
    await panel.getByRole("button", { name: "지원 참조 번호 복사" }).click();
    expect(await page.evaluate(() => (window as Window & { copiedReference?: string }).copiedReference)).toBe(`ref ${envelope!.support_ref}`);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await panel.getByRole("button", { name: "지원 참조 번호 복사" }).click();
    await expect(panel.getByText(envelope!.support_ref, { exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: t("common.cancel"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByText("지원 참조 번호 조회", { exact: true }).click();
    await page.getByLabel("전체 지원 참조 번호").fill(`ref ${envelope!.support_ref.slice(0, 8)}`);
    await expect(async () => {
      await page.getByLabel("전체 지원 참조 번호").press("Enter");
      await expect(page.getByText(envelope!.trace_id, { exact: true })).toBeVisible();
    }).toPass();
    await expect(page.getByText("/__e2e/support-reference-failure", { exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll();
    await page.reload();
  }
});
