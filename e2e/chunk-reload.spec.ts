import { expectAccessible } from "./a11y";
import { expect, test, type Page, type Route } from "@playwright/test";
import { newContext, vendorPage } from "./flows";

// A deploy must never leave a blank page (2026-10-08: a blue/green canary served index.html from one build and its
// chunks from the other; a browser holding a cached index.html after a promotion did the same). A missing chunk
// reloads the page once, with a request for index.html no cache can answer (`_r`); after that, an error screen with
// a reload button. Chunks are matched in both shapes: Vite dev serves sources, a build serves hashed assets.
const TENANTS_CHUNK = /^\/(src\/features\/platform\/Tenants\.tsx|assets\/Tenants-[\w-]+\.js)$/;
const ENTRY = /src="(\/src\/main\.tsx|\/assets\/index-[\w-]+\.js)"/;
const GONE = "/assets/index-gone.js";
const CRASHED = "화면을 표시하지 못했습니다";
const RELOAD = "페이지 새로 고침";

/** The page's document requests (each load or reload of index.html), in order. */
function documents(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) urls.push(r.url());
  });
  return urls;
}
const busted = (url: string) => new URL(url).searchParams.has("_r");
const notFound = (route: Route) => route.fulfill({ status: 404, headers: { "cache-control": "no-cache" }, body: "" });
/** Nothing navigates on its own any more: a second look a while later sees the same documents. */
async function settled(urls: string[], count: number) {
  await new Promise((r) => setTimeout(r, 1500));
  expect(urls).toHaveLength(count);
}

test("a lazy screen chunk missing once reloads the page once, afresh, and the screen renders", async ({ browser }) => {
  const page = await vendorPage(browser);
  let tries = 0;
  await page.route((u) => TENANTS_CHUNK.test(u.pathname), (route) => (++tries === 1 ? notFound(route) : route.continue()));
  const docs = documents(page);
  await page.goto("/platform");
  await expect(page.getByRole("button", { name: "고객 계정 개설" })).toBeVisible();
  await settled(docs, 2);
  expect(busted(docs[1]!)).toBe(true); // not a plain reload, which a stale cached index.html would answer
  expect(busted(page.url())).toBe(false); // the parameter is gone before the router reads the URL
  expect(tries).toBe(2);
  await expect(page.getByText(CRASHED)).toBeHidden();
  await page.unrouteAll();
});

test("a lazy screen chunk that stays missing reloads once, then shows the error screen; its button reloads afresh", async ({ browser }) => {
  const page = await vendorPage(browser);
  let tries = 0;
  await page.route((u) => TENANTS_CHUNK.test(u.pathname), (route) => (++tries, notFound(route)));
  const docs = documents(page);
  await page.goto("/platform");
  await expect(page.getByRole("heading", { name: CRASHED })).toBeVisible();
  await expect(page.locator("[data-support-reference]")).toBeVisible();
  await expect(page.getByRole("button", { name: "지원 참조 번호 복사" })).toBeVisible();
  await expectAccessible(page, "chunk recovery support reference");
  await settled(docs, 2); // one reload, no loop
  expect(busted(docs[1]!)).toBe(true);
  expect(tries).toBe(2);

  // The button reloads afresh; still missing, the screen comes back without a reload of its own.
  await page.getByRole("button", { name: RELOAD }).click();
  await expect(page.getByRole("heading", { name: CRASHED })).toBeVisible();
  await settled(docs, 3);
  expect(busted(docs[2]!)).toBe(true);

  // The chunk is back: the button brings the screen, and that load clears the guard for the next deploy.
  await page.unrouteAll();
  await page.getByRole("button", { name: RELOAD }).click();
  await expect(page.getByRole("button", { name: "고객 계정 개설" })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("console.chunk-reload:")))).toEqual([]);
});

/**
 * The browser keeps an index.html from before the deploy: a plain request for the page is answered with it (as a
 * 304 revalidation would), and its entry chunk is gone. `always`: the cache-busting request gets it too.
 */
async function staleIndex(page: Page, always = false) {
  await page.route(GONE, notFound);
  await page.route(
    (u) => u.pathname === "/login",
    async (route) => {
      if (!always && busted(route.request().url())) return route.continue();
      const res = await route.fetch();
      const html = await res.text();
      expect(html).toMatch(ENTRY);
      return route.fulfill({ response: res, body: html.replace(ENTRY, `src="${GONE}"`) });
    },
  );
}

test("a stale index.html whose entry chunk is gone reloads once, afresh, and signs in as usual", async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await staleIndex(page);
  const docs = documents(page);
  await page.goto("/login");
  await expect(page.getByLabel("일회용 코드")).toBeVisible();
  await settled(docs, 2);
  expect(busted(docs[1]!)).toBe(true);
  expect(busted(page.url())).toBe(false);
  await page.context().close();
});

test("an entry chunk that stays missing reloads once, then shows the static error screen, never a blank page", async ({ browser }) => {
  const page = await (await newContext(browser)).newPage();
  await staleIndex(page, true);
  const docs = documents(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: CRASHED })).toBeVisible();
  await expect(page.locator("[data-support-reference]")).toBeVisible();
  await expectAccessible(page, "stale entry support reference");
  await settled(docs, 2);
  expect(busted(docs[1]!)).toBe(true);
  await page.getByRole("button", { name: RELOAD }).click();
  await expect(page.getByRole("heading", { name: CRASHED })).toBeVisible();
  await settled(docs, 3);
  expect(busted(docs[2]!)).toBe(true);
  await page.context().close();
});
