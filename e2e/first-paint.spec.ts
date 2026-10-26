// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go, routeReady, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { tenantBeforeSetup } from "./setup-flows";
import { clearShifts, expectStable } from "./stability";
import { openCard, soloWorld } from "./record-actions/world";

test("a delayed personnel action chunk leaves the open card body in place", async ({ browser }) => {
  const world = await soloWorld(browser, "firstpaint-card", "첫 화면 인사카드 검증", false);
  const { admin } = world;
  const chunk = /\/person-act(?:\.tsx|-[^/]+\.js)(?:\?|$)/;
  const pending = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  await admin.route(chunk, async route => {
    requested.resolve();
    await pending.promise;
    await route.continue();
  });
  try {
    await openCard(world);
    await admin.getByRole("button", { name: "사번 변경", exact: true }).click();
    await requested.promise;
    await expect(admin.getByRole("dialog", { name: "사번 변경" })).toBeVisible();
    const body = admin.locator("main");
    await expect(body.locator("[aria-busy]")).toHaveCount(0);
    const first = admin.locator("#s1");
    const before = await first.boundingBox();
    expect(before).not.toBeNull();
    await admin.evaluate(clearShifts);
    const loaded = admin.waitForResponse(response => chunk.test(response.url()));
    pending.resolve();
    await loaded;
    await expectStable(admin, "personnel action chunk resolved");
    expect(await first.boundingBox()).toEqual(before);
    await expect(body.locator("[aria-busy]")).toHaveCount(0);
  } finally {
    pending.resolve();
    await admin.unroute(chunk);
  }
});

test("a delayed card print chunk shows the card wait, never a blank page", async ({ browser }) => {
  const world = await soloWorld(browser, "firstpaint-print", "첫 화면 인쇄 검증", false);
  const { admin } = world;
  const chunk = /\/card-print(?:\.tsx|-[^/]+\.js)(?:\?|$)/;
  const pending = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  await admin.route(chunk, async route => {
    requested.resolve();
    await pending.promise;
    await route.continue();
  });
  try {
    await openCard(world);
    await admin.getByRole("button", { name: "인사카드 인쇄", exact: true }).first().click();
    await requested.promise;
    await expect(admin.locator("main").getByRole("status")).toBeVisible();
    const loaded = admin.waitForResponse(response => chunk.test(response.url()));
    pending.resolve();
    await loaded;
    await expect(admin.locator("main").getByRole("status")).toHaveCount(0);
  } finally {
    pending.resolve();
    await admin.unroute(chunk);
  }
});

test("platform first paint shares one read and late fonts leave controls and headings in place", async ({ browser }) => {
  const page = await vendorPage(browser);
  await go(page, "/platform");
  await page.getByRole("button", { name: "고객 계정 개설" }).click();
  await page.getByLabel("고객 이름").fill("첫 화면 글꼴 검증");
  await tenantSlugField(page).fill(unique("firstpaint-fonts"));
  await tenantOnboardSubmit(page).click();
  await takeCode(page);
  const fonts = Promise.withResolvers<void>();
  let requests = 0;
  page.on("request", req => { if (req.method() === "GET" && new URL(req.url()).pathname === "/api/platform/orgs") requests++; });
  await page.route("**/*.woff2", async route => { await fonts.promise; await route.continue(); });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await routeReady(page, "/platform");
    // Longer than optional's short block period, while the font network is deliberately still pending.
    await page.waitForTimeout(200);
    await page.evaluate(clearShifts);
    const targets = [page.getByRole("button", { name: "고객 계정 개설" }), page.getByRole("heading", { level: 1 }), page.getByRole("columnheader").first()];
    const before = await Promise.all(targets.map(target => target.boundingBox()));
    expect(before.every(Boolean)).toBe(true);
    fonts.resolve();
    await page.evaluate(() => document.fonts.ready);
    expect(await Promise.all(targets.map(target => target.boundingBox()))).toEqual(before);
    expect(requests).toBe(1);
    await expectStable(page, "platform late optional fonts");
    await go(page, "/account");
    const link = page.locator('a[href="/platform"]').first();
    await link.hover();
    await link.click();
    await routeReady(page, "/platform");
    expect(requests).toBe(1);
  } finally { fonts.resolve(); await page.unroute("**/*.woff2"); }
});

test("the shell paints during a pending authz read and degrades on faults", async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "firstpaint-authz", "첫 화면 권한 검증");
  const pending = Promise.withResolvers<void>();
  let reads = 0;
  await admin.route("**/api/v1/me/authz", async route => {
    reads++;
    await pending.promise;
    await route.continue();
  });
  try {
    await admin.reload({ waitUntil: "domcontentloaded" });
    await expect(admin.getByRole("button", { name: "로그아웃" })).toBeVisible();
    await expect.poll(() => reads).toBe(1);
  } finally { pending.resolve(); }
  await routeReady(admin);
  expect(reads).toBe(1);
  await admin.unroute("**/api/v1/me/authz");
  for (const status of [500, 0]) {
    await admin.route("**/api/v1/me/authz", route => status === 0 ? route.abort("failed") : route.fulfill({ status, json: { code: "internal_error" } }));
    await admin.reload({ waitUntil: "domcontentloaded" });
    await expect(admin.getByRole("button", { name: "로그아웃" })).toBeVisible();
    await routeReady(admin);
    await expect(admin.getByRole("link", { name: "인사", exact: true })).toBeVisible();
    await expect(admin.getByText("화면을 표시하지 못했습니다", { exact: true })).toHaveCount(0);
    await admin.unroute("**/api/v1/me/authz");
  }
});

test("a platform refusal belongs to the Denied screen", async ({ browser }) => {
  const page = await vendorPage(browser);
  await go(page, "/platform");
  await page.route("**/api/platform/orgs", route => route.fulfill({ status: 403, json: { code: "access_denied" } }));
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("region", { name: "이 화면에 접근 권한이 없습니다", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  } finally {
    await page.unroute("**/api/platform/orgs");
    // vendorPage is shared with later journeys; discard the mocked refusal in its query cache.
    await page.reload({ waitUntil: "domcontentloaded" });
    await routeReady(page, "/platform");
  }
});
