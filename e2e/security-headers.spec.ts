// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { tenantInSetup } from "./setup-flows";

test("the origin serves API refusal and fallback responses with security headers", async ({ request }) => {
  for (const path of ["/api", "/api/v1/does-not-exist"]) {
    const response = await request.get(path);
    await test.info().attach(`headers ${path}`, { body: JSON.stringify(response.headers(), null, 2), contentType: "application/json" });
    expect(response.status()).toBe(404);
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  }
  const crossSite = await request.post("/api/v1/auth/token/refresh", {
    headers: { cookie: "__Host-console_refresh=unspent-token", origin: "https://foreign.example.test", "sec-fetch-site": "cross-site", "x-auth-transport": "cookie" },
    data: {},
  });
  expect(crossSite.status()).toBe(403);
  expect(crossSite.headers()["set-cookie"]).toBeUndefined();
  expect(crossSite.headers()["x-content-type-options"]).toBe("nosniff");
  expect(crossSite.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");

  const legacyIgnored = await request.post("/api/v1/auth/token/refresh", {
    headers: { cookie: "console_refresh=unspent-token", origin: "https://foreign.example.test", "sec-fetch-site": "cross-site", "x-auth-transport": "cookie" },
    data: {},
  });
  expect(legacyIgnored.status()).toBe(401);
  expect(legacyIgnored.headers()["set-cookie"]).toBeUndefined();
  expect(legacyIgnored.headers()["x-content-type-options"]).toBe("nosniff");
  expect(legacyIgnored.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
});

test("the served SPA declares its charset and forbids plugins and base rewriting", async ({ request }) => {
  test.skip(process.env.E2E_SERVED !== "1", "SPA origin headers require the served production shape");
  for (const path of ["/", "/account"]) {
    const response = await request.get(path);
    await test.info().attach(`headers ${path}`, { body: JSON.stringify(response.headers(), null, 2), contentType: "application/json" });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/html; charset=utf-8");
    const policy = response.headers()["content-security-policy"];
    expect(policy).toContain("object-src 'none';");
    expect(policy).toContain("base-uri 'none';");
    expect(policy).toContain("frame-ancestors 'none';");
  }
});

test("legacy console_refresh cookie is ignored while __Host-console_refresh rotates on reload", { tag: "@auth" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "cookiemigration", "쿠키전환주식회사");
  const context = admin.context();
  const hostCookie = (await context.cookies()).find((cookie) => cookie.name === "__Host-console_refresh");
  expect(hostCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  expect(await admin.evaluate(() => document.cookie)).not.toContain("console_refresh");
  // Reload with the host-bound cookie rotates it cleanly.
  const rotatedReq = admin.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/token/refresh");
  await admin.reload();
  expect((await rotatedReq).status()).toBe(200);
  const rotated = (await context.cookies()).find((cookie) => cookie.name === "__Host-console_refresh");
  expect(rotated?.value).not.toBe(hostCookie?.value);
  // Replacing __Host-console_refresh with legacy console_refresh is refused (401).
  await context.clearCookies({ name: "__Host-console_refresh" });
  await context.addCookies([{ ...rotated!, name: "console_refresh", path: "/api/v1/auth" }]);
  const legacyReq = admin.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/token/refresh");
  await admin.reload();
  expect((await legacyReq).status()).toBe(401);
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain("__Host-console_refresh");
});
