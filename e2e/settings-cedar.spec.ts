// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";

test("solo admin can write settings and add reason codes on Cedar, with negative refusals asserted", async ({ browser, playwright, baseURL }) => {
  const admin = await openTenant(browser, "cedarset", "설정테넌트");
  const bearer = bearerOf(admin);
  await go(admin, "/");
  await expect.poll(bearer, { timeout: 15_000 }).not.toBe("");

  const api = apiOf(admin, bearer);

  // 1. Settings write: tighten approval policy (none -> route)
  // The first administrator is the tenant ops account; Cedar grants its authority.
  const setRes = await api(
    "/settings/approval.policy.org_structure",
    "POST",
    { value: "route", reason_code: "POLICY_REVIEW" },
  );
  expect(setRes.status()).toBe(201);

  // Verify setting took effect
  const settingsRes = await api("/settings");
  expect(settingsRes.status()).toBe(200);
  const settingsJson = (await settingsRes.json()) as { items: { key: string; value: unknown }[] };
  const orgPolicy = settingsJson.items.find((i) => i.key === "approval.policy.org_structure");
  expect(orgPolicy?.value).toBe("route");

  // 2. Reason code add: in open domain
  // Ops authority also covers open reason domains.
  const reasonRes = await api(
    "/reason-codes",
    "POST",
    { domain: "org_change_reason", label_ko: "테스트 조직 개편", requires_note: false },
  );
  expect(reasonRes.status()).toBe(201);

  // Verify reason code was added
  const catalogRes = await api("/reason-codes?domain=org_change_reason");
  expect(catalogRes.status()).toBe(200);
  const catalogJson = (await catalogRes.json()) as { items: { label_ko: string }[] };
  expect(catalogJson.items.some((i) => i.label_ko === "테스트 조직 개편")).toBe(true);

  // 3. Negative refusal tests:
  // a) Loosening without step-up -> 403 step_up_required
  const loosenWithoutStepUp = await api(
    "/settings/approval.policy.org_structure",
    "POST",
    { value: "none", reason_code: "POLICY_REVIEW" },
  );
  expect(loosenWithoutStepUp.status()).toBe(403);
  expect(await codeOf(loosenWithoutStepUp)).toBe("step_up_required");

  // b) Value outside legal bounds -> 422
  const invalidValue = await api(
    "/settings/approval.policy.org_structure",
    "POST",
    { value: "unauthorized_policy_mode", reason_code: "POLICY_REVIEW" },
  );
  expect(invalidValue.status()).toBe(422);

  // c) Closed governance reason domain -> 403 reason_domain_closed
  const closedDomain = await api(
    "/reason-codes",
    "POST",
    { domain: "exception", label_ko: "임의 예외 사유", requires_note: false },
  );
  expect(closedDomain.status()).toBe(403);
  expect(await codeOf(closedDomain)).toBe("reason_domain_closed");

  // d) Unauthenticated requests -> 401
  const unauthenticated = await playwright.request.newContext({ baseURL });
  const unauthSetting = await unauthenticated.fetch("/api/v1/settings/approval.policy.org_structure", {
    method: "POST",
    data: { value: "route", reason_code: "POLICY_REVIEW" },
    failOnStatusCode: false,
  });
  expect(unauthSetting.status()).toBe(401);

  const unauthReason = await unauthenticated.fetch("/api/v1/reason-codes", {
    method: "POST",
    data: { domain: "org_change_reason", label_ko: "무단 사유", requires_note: false },
    failOnStatusCode: false,
  });
  expect(unauthReason.status()).toBe(401);
  await unauthenticated.dispose();
});
