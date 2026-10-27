// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { mockRoute } from "./route";
import { AT, facets, user } from "./fixtures";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";
import { readRequirement, routeReads } from "../../apps/web/src/routes/route-reads";
import { accessRefusal } from "../../apps/web/src/reference/authz/domain/access";
import type { AccessEffective } from "../../apps/web/src/reference/authz/api";
import { accessScreens, mockAccessScreen } from "../states/access";

test("contract routes match methods and path parameters, preserve queries, and fall back", async ({ page }) => {
  await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ status: 418, json: { fallback: true } }));
  await mockRoute(page, "get", "/api/v1/employees", request => ({ status: 200, json: { items: [], total: Number(new URL(request.url()).searchParams.get("offset")), limit: 10, offset: 0, next_cursor: null } }));
  await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 403, json: { error: { code: "forbidden", message: "권한이 없습니다." } } });
  await page.goto("/_gallery");
  const result = await page.evaluate(async () => {
    const get = await fetch("/api/v1/employees?offset=7");
    const post = await fetch("/api/v1/employees", { method: "POST" });
    const record = await fetch("/api/v1/employees/one");
    const nested = await fetch("/api/v1/employees/one/history");
    return { body: await get.json(), post: post.status, record: record.status, nested: nested.status };
  });
  expect(result).toEqual({ body: { items: [], total: 7, limit: 10, offset: 0, next_cursor: null }, post: 418, record: 403, nested: 418 });
});

test("an async response factory holds a read until released", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/org-units", async () => {
    await held;
    return { status: 200, json: { items: [] } };
  });
  await page.goto("/_gallery");
  const requested = page.waitForRequest("**/api/v1/org-units");
  const result = page.evaluate(async () => (await fetch("/api/v1/org-units")).json());
  await requested;
  release();
  expect(await result).toEqual({ items: [] });
});

test("roster facets succeed beside the parameterized employee read", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await page.goto("/_gallery");
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/v1/employees/facets");
    return { status: response.status, body: await response.json() };
  });
  expect(result).toEqual({ status: 200, body: facets(fixture.count) });
  expect(fixture.unexpected).toEqual([]);
});

test("large roster follows opaque cursors through every employee to exhaustion", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "large");
  await page.goto("/_gallery");
  const pages = await page.evaluate(async () => {
    const pages: { ids: string[]; cursor: string | null }[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "1000", ...(cursor ? { cursor } : {}) });
      const response = await fetch(`/api/v1/employees?${query}`);
      const body: components["schemas"]["EmployeePage"] = await response.json();
      pages.push({ ids: body.items.map((row: { id: string }) => row.id), cursor: body.next_cursor });
      cursor = body.next_cursor;
    } while (cursor && pages.length < 3);
    return pages;
  });
  expect(pages.map(page => page.ids.length)).toEqual([1000, 1000]);
  expect(pages[0]!.cursor).toBe(pages[0]!.ids.at(-1));
  expect(pages[1]!.cursor).toBeNull();
  expect(new Set(pages.flatMap(page => page.ids)).size).toBe(fixture.count);
  expect(fixture.unexpected).toEqual([]);
});

// Compiled by npm run typecheck; never executed. Each assertion must stay rejected by the generated contract.
function contractErrors(page: Page) {
  // @ts-expect-error an unknown endpoint is not a contract route
  void mockRoute(page, "get", "/api/v1/not-a-real-route", { status: 200, json: {} });
  // @ts-expect-error employees has no PUT operation
  void mockRoute(page, "put", "/api/v1/employees", { status: 200, json: {} });
  // @ts-expect-error a list success must contain the employee page
  void mockRoute(page, "get", "/api/v1/employees", { status: 200, json: { items: [] } });
  // @ts-expect-error a response cannot silently drift to a different shape in a factory either
  void mockRoute(page, "get", "/api/v1/employees", () => ({ status: 200, json: { total: "many" } }));
  // @ts-expect-error the common failure envelope is typed too
  void mockRoute(page, "get", "/api/v1/employees", { status: 403, json: { error: "forbidden" } });
  // @ts-expect-error a read cannot return an undocumented success status
  void mockRoute(page, "get", "/api/v1/employees", { status: 201, json: { items: [], total: 0, limit: 100, offset: 0, next_cursor: null } });
}
void contractErrors;

test("screen mocks preserve a Request's JSON body for commands", async ({ page }) => {
  await mockScreen(page, screens[2], "populated");
  await page.route("**/mock-command", route => route.fulfill({ json: route.request().postDataJSON() }));
  await page.goto("/_gallery");
  const body = await page.evaluate(async () => {
    const request = new Request(new URL("/mock-command", location.href), { method: "PUT", body: JSON.stringify({ expected_version: 7 }) });
    return (await fetch(request)).json();
  });
  expect(body).toEqual({ expected_version: 7 });
});

test("effective screen grants follow every generated route requirement without ops bypass", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "empty");
  await page.goto("/_gallery");
  for (const path of Object.keys(routeReads) as (keyof typeof routeReads)[]) {
    await test.step(path, async () => {
      const access: AccessEffective = await page.evaluate(async path => (await fetch("/api/v1/access/me", {
        referrer: new URL(`${path.replace(/\$[^/]+/g, "fixture-id")}?view=all`, location.href).href,
      })).json(), path);
      const need = readRequirement(path);
      const requirements = "allOf" in need ? need.allOf : [need];
      // An empty generated scope list is ops-only; the fixture must preserve that refusal.
      const grantable = requirements.filter(need => need.scopes?.length !== 0);
      expect(access.is_ops).toBe(false);
      expect(accessRefusal(access, need), path).toBe(grantable.length === requirements.length ? null : "access_denied");
      expect(access.entries.map(({ domain, level }) => ({ domain, level }))).toEqual(
        [...new Map(grantable.map(({ domain, level }) => [`${domain}/${level}`, { domain, level }])).values()],
      );
      expect(access.entries.every(entry => entry.enforcement === "ENFORCED")).toBe(true);
    });
  }
  const signedIn: AccessEffective = await page.evaluate(async () => (await fetch("/api/v1/access/me")).json());
  expect(signedIn.entries).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("a per-screen effective-access override still refuses before the page reads", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: {
    account_id: user.id, is_ops: false, phase: "OPERATING", as_of: AT, entries: [],
  } });
  const reads: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === screens[1].read) reads.push(request.url()); });
  await page.goto(screens[1].path);
  await expect(page.getByRole("main").getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
  expect(reads).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("a refused access state reaches its 403 read and renders the refusal card", async ({ page }) => {
  const screen = accessScreens[0];
  const fixture = await mockAccessScreen(page, screen, "refused");
  const response = page.waitForResponse(response => new URL(response.url()).pathname === screen.read);
  await page.goto(screen.path);
  expect((await response).status()).toBe(403);
  await expect(page.getByRole("main").getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
