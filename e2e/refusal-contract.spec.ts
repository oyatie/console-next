// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { soloTenant } from "./chaos";
import { go } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";

test("a publish refusal keeps its preflight checklist over the assembled HTTP stack", { tag: "@regression" }, async ({ browser }) => {
  const page = await soloTenant(browser, "preflight-contract", "합성 채용 회사");
  try {
    const bearer = bearerOf(page);
    await go(page, "/account");
    await page.reload();
    await expect.poll(bearer).not.toBe("");
    const api = apiOf(page, bearer);
    const draft = await api("/recruiting/postings", "POST", {
      role_title: "합성 채용 직무", company: "합성 회사", worksite: "합성 근무지",
      employment_type: "REGULAR", scope: "EXTERNAL", headcount: 1, deadline: null,
      requirements: ["합성 채용 요건"],
    });
    expect(draft.status()).toBe(201);
    const posting = await draft.json() as { id: string; updated_at: string };
    const refused = await api(`/recruiting/postings/${posting.id}/publish`, "POST", {
      attest_exposure_scope: false, expected_updated_at: posting.updated_at,
    });
    expect(refused.status()).toBe(422);
    expect(refused.headers()["content-type"]).toContain("application/problem+json");
    const body = await refused.json() as { error: { code: string }; publishable: boolean; checks: { key: string; ok: boolean }[] };
    expect(body.error.code).toBe("PREFLIGHT_FAILED");
    expect(body.publishable).toBe(false);
    expect(body.checks).toEqual(expect.arrayContaining([expect.objectContaining({ key: "exposure_attested", ok: false })]));
    const unchanged = await api(`/recruiting/postings/${posting.id}`);
    expect(unchanged.status()).toBe(200);
    expect(await unchanged.json()).toMatchObject({ posting: { status: "DRAFT", updated_at: posting.updated_at } });
  } finally {
    await page.context().close();
  }
});
