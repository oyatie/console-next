// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { tenantInSetup } from "./setup-flows";

test("workplace settings inherit the legal entity and explain the deciding layer", async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "settingsscope", "설정범위", false, "본사");
  const bearer = bearerOf(admin);
  await admin.reload();
  await expect.poll(bearer, { timeout: 15_000 }).not.toBe("");
  const api = apiOf(admin, bearer);
  const entities = await api("/legal-entities");
  expect(entities.status()).toBe(200);
  const entity = (await entities.json()).items[0];
  const detail = await api(`/legal-entities/${entity.id}`);
  expect(detail.status()).toBe(200);
  const workplace = (await detail.json()).workplaces[0];
  const key = "approval.delegation.max_days";
  const read = async () => {
    const response = await api(`/settings?entity=${workplace.id}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.can_change).toBe(true);
    return body.items.find((item: { key: string }) => item.key === key);
  };
  const tenant = await api(`/settings/${key}`, "POST", {
    value: 25, reason_code: "POLICY_REVIEW",
  });
  expect(tenant.status()).toBe(201);
  const tenantEntry = await read();
  expect(tenantEntry.source.layer).toBe("tenant");
  expect(tenantEntry.chain.filter((layer: { deciding: boolean }) => layer.deciding)).toHaveLength(1);
  const orphanRead = await api(`/settings?entity=${crypto.randomUUID()}`);
  expect(orphanRead.status()).toBe(422);
  expect(await codeOf(orphanRead)).toBe("setting_scope_unknown");
  const inherited = await api(`/settings/${key}`, "POST", {
    scope_entity_id: entity.id, value: 20, reason_code: "POLICY_REVIEW",
  });
  expect(inherited.status()).toBe(201);
  expect(await read()).toMatchObject({ value: 20, source: { layer: "legal_entity", scope_entity_id: entity.id } });
  const applied = await api(`/settings/${key}`, "POST", {
    scope_entity_id: workplace.id, value: 10, reason_code: "POLICY_REVIEW",
  });
  expect(applied.status()).toBe(201);
  const entry = await read();
  expect(entry.source).toEqual({ layer: "workplace", scope_entity_id: workplace.id });
  expect(entry.chain).toEqual([
    expect.objectContaining({ layer: "workplace", value: 10, deciding: true }),
    expect.objectContaining({ layer: "legal_entity", value: 20, deciding: false }),
    expect.objectContaining({ layer: "tenant", value: 25, deciding: false }),
    expect.objectContaining({ layer: "code_default", value: 30, deciding: false }),
  ]);
  for (const query of ["?dry_run=true", ""]) {
    const unknown = await api(`/settings/${key}${query}`, "POST", {
      scope_entity_id: crypto.randomUUID(), value: 10, reason_code: "POLICY_REVIEW",
    });
    expect(unknown.status()).toBe(422);
    expect(await codeOf(unknown)).toBe("setting_scope_unknown");
  }
  expect(await read()).toEqual(entry);
});
