// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";

test("privacy rights use closed statutory catalogs and a configurable operational objection clock", async ({ browser }) => {
  const admin = await openTenant(browser, "rightspolicy", "권리접수테넌트");
  const bearer = bearerOf(admin);
  await go(admin, "/");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  for (const [domain, codes] of [
    ["privacy_refusal_access", ["LAW_PROHIBITS", "HARM_TO_OTHERS"]],
    ["privacy_refusal_deletion", ["REQUIRED_BY_LAW"]],
    ["privacy_refusal_suspension", ["LAW_REQUIRES", "HARM_TO_OTHERS", "CONTRACT_PERFORMANCE"]],
    ["privacy_postpone_access", ["JUSTIFIED_REASON"]],
    ["privacy_identity_method", ["SIGNED_IN", "ID_DOCUMENT_SEEN", "KNOWN_CONTACT", "AGENT_MANDATE"]],
  ] as const) {
    const response = await api(`/reason-codes?domain=${domain}`);
    expect(response.status()).toBe(200);
    const catalog = await response.json() as { items: { code: string; requires_note: boolean }[] };
    expect(catalog.items.map((item) => item.code)).toEqual(codes);
    if (domain === "privacy_postpone_access") expect(catalog.items[0]?.requires_note).toBe(true);
    const refused = await api("/reason-codes", "POST", { domain, label_ko: "임의 사유", requires_note: false });
    expect(refused.status()).toBe(403);
    expect(await codeOf(refused)).toBe("reason_domain_closed");
    expect(await (await api(`/reason-codes?domain=${domain}`)).json()).toEqual(catalog);
  }
  const key = "privacy.rights.objection_review_days";
  const settings = await (await api("/settings")).json() as { items: { key: string; value: number }[] };
  expect(settings.items.find((item) => item.key === key)?.value).toBe(10);
  const tightened = await api(`/settings/${key}`, "POST", { value: 7, reason_code: "POLICY_REVIEW" });
  expect(tightened.status()).toBe(201);
  const changed = await (await api("/settings")).json() as typeof settings;
  expect(changed.items.find((item) => item.key === key)?.value).toBe(7);
  for (const value of [0, 31]) {
    expect((await api(`/settings/${key}`, "POST", { value, reason_code: "POLICY_REVIEW" })).status()).toBe(422);
  }
});
