// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";

test("settings preview preserves values and leaves its idempotency key available for apply", async ({ browser }) => {
  const admin = await openTenant(browser, "settingplan", "설정미리보기");
  const bearer = bearerOf(admin);
  await go(admin, "/");
  await expect.poll(bearer, { timeout: 15_000 }).not.toBe("");
  const api = apiOf(admin, bearer);
  const key = "approval.policy.org_structure";
  const path = `/settings/${key}`;
  const read = async () => {
    const response = await api("/settings");
    expect(response.status()).toBe(200);
    const body = await response.json() as { items: { key: string; value: unknown; version: unknown; scheduled: unknown[] }[] };
    return body.items.find((item) => item.key === key)!;
  };
  const before = await read();
  const change = { value: "route", reason_code: "POLICY_REVIEW", expected_version: before.version };
  const headers = { "Idempotency-Key": crypto.randomUUID() };
  for (const query of ["true", "%74rue"]) {
    const response = await api(`${path}?dry_run=${query}`, "POST", change, headers);
    expect(response.status()).toBe(200);
    const plan = await response.json();
    expect(plan).toMatchObject({ direction: "tighten", path: "direct", requires: { reason: true, step_up: false, second_person: false } });
    expect(plan.in_force).toEqual({ value: before.value, version: before.version, scope_entity_id: null });
    expect(plan.reaches).toEqual({ scope_entity_id: null, keeps_own_value: [] });
    expect(await read()).toEqual(before);
  }
  const applied = await api(path, "POST", change, headers);
  expect(applied.status()).toBe(201);
  const current = await read();
  expect(current.value).toBe("route");
  for (const query of ["?dry_run=true", ""]) {
    const stale = await api(`${path}${query}`, "POST", change);
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: "setting_version_stale", current_version: current.version });
    expect(await read()).toEqual(current);
  }

  const loosen = { value: "none", reason_code: "POLICY_REVIEW" };
  const preview = await api(`${path}?dry_run=true`, "POST", loosen);
  expect(preview.status()).toBe(200);
  expect(await preview.json()).toMatchObject({ path: "step_up", requires: { step_up: true } });
  const refused = await api(path, "POST", loosen);
  expect(refused.status()).toBe(403);
  expect(await codeOf(refused)).toBe("step_up_required");
  for (const query of ["?dry_run=true", ""]) {
    const invalid = await api(`${path}${query}`, "POST", { value: "invalid", reason_code: "POLICY_REVIEW" });
    expect(invalid.status()).toBe(422);
    expect(await codeOf(invalid)).toBe("setting_value_invalid");
  }
  expect(await read()).toEqual(current);
});
