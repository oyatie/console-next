// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { mockRoute } from "./route";
import { facets } from "./fixtures";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

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
