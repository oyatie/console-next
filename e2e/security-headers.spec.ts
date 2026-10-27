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
  for (const name of ["__Host-console_refresh", "console_refresh"]) {
    const response = await request.post("/api/v1/auth/token/refresh", {
      headers: { cookie: `${name}=unspent-token`, origin: "https://foreign.example.test", "sec-fetch-site": "cross-site", "x-auth-transport": "cookie" },
      data: {},
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  }
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

test("a host-bound refresh cookie migrates the N-1 browser session on reload", { tag: "@auth" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "cookiemigration", "쿠키전환주식회사");
  const context = admin.context();
  const hostCookie = (await context.cookies()).find((cookie) => cookie.name === "__Host-console_refresh");
  expect(hostCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  expect(await admin.evaluate(() => document.cookie)).not.toContain("console_refresh");
  // Replay the N-1 browser state: its next document load migrates the live session.
  await context.clearCookies({ name: "__Host-console_refresh" });
  await context.addCookies([{ ...hostCookie!, name: "console_refresh", path: "/api/v1/auth" }]);
  const migrated = admin.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/token/refresh");
  await admin.reload();
  expect((await migrated).status()).toBe(200);
  await expect.poll(async () => (await context.cookies()).map((cookie) => cookie.name)).toContain("__Host-console_refresh");
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain("console_refresh");
  const rotated = (await context.cookies()).find((cookie) => cookie.name === "__Host-console_refresh");
  expect(rotated?.value).not.toBe(hostCookie?.value);
});
