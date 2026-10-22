// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { soloTenant } from "./chaos";

test("a signed-in administrator gets an atomic bulk refusal and can still evaluate an ordinary batch", async ({ browser }) => {
  const page = await soloTenant(browser, "policy-bulk", "정책 검증");
  const authenticated = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/v1/users/me" && !!r.headers()["authorization"]);
  await page.reload();
  const authorization = (await authenticated).headers()["authorization"]!;
  const claims = JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString());
  const subject = { org: claims.org, user_id: claims.sub, roles: [], clearance_keys: [] };
  const check = { action: "view", resource: { org: claims.org, resource_type: "work_order" } };
  const headers = { authorization };
  const feed = async () => {
    const response = await page.request.get("/api/v1/policy/decisions", { headers });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const before = await feed();
  for (const data of [
    { subject, checks: Array.from({ length: 201 }, () => check) },
    { subject: { ...subject, user_id: "x".repeat(128 * 1024) }, checks: Array.from({ length: 17 }, () => check) },
  ]) {
    const response = await page.request.post("/api/v1/policy/authorize/bulk", { headers, data });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe("policy_bulk_limit");
    expect(await feed()).toEqual(before);
  }
  const accepted = await page.request.post("/api/v1/policy/authorize/bulk", { headers, data: { subject, checks: [check, check] } });
  expect(accepted.ok()).toBe(true);
  expect((await accepted.json()).decisions).toHaveLength(2);
  expect(await feed()).toHaveLength(before.length + 2);
});
