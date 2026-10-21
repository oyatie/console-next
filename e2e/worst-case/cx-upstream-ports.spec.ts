import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { soloTenant } from "../chaos";

// All accounts and passkeys are created through the product on the empty stack.
test("cookie logout revokes the session and unauthorized responses expose the JSON code", { tag: "@auth" }, async ({ browser }) => {
  const admin = await soloTenant(browser, "cxauthco", "세션검증");
  await go(admin, "/account");
  await expectAccessible(admin, "cookie session account");
  const loggedOut = admin.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/v1/auth/logout"));
  await admin.getByRole("button", { name: "이 기기에서 로그아웃" }).click();
  const response = await loggedOut;
  expect(response.status()).toBe(204);
  expect(Boolean(response.request().headers()["authorization"])).toBe(false);
  await expect(admin).toHaveURL(/\/login/);
  await admin.reload();
  await expect(admin).toHaveURL(/\/login/);
  const refusal = await admin.evaluate(async () => {
    const result = await fetch("/api/v1/users/me", { credentials: "same-origin" });
    return { status: result.status, type: result.headers.get("content-type"), body: await result.json() };
  });
  expect(refusal.status).toBe(401);
  expect(refusal.type).toContain("application/json");
  expect(refusal.body.error.code).toBe("unauthorized");
  await expectAccessible(admin, "logged out cookie session");
});
