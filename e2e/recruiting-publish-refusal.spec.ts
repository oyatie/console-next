// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { go } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";

test("a recruiting publish refusal retains its preflight checks and leaves the draft unchanged", async ({ browser }) => {
  const page = await openTenant(browser, "recruitpublish", "채용 검증 회사");
  try {
    const bearer = bearerOf(page);
    await go(page, "/account");
    await expect.poll(bearer).not.toBe("");
    const api = apiOf(page, bearer);
    // Recruiting has no composer screen yet; exercise its published HTTP contract.
    const created = await api("/recruiting/postings", "POST", {
      role_title: "정비 기술자", company: "채용 검증 회사", worksite: "본점",
      employment_type: "REGULAR", scope: "EXTERNAL", headcount: 1,
      deadline: null, requirements: [],
    } satisfies components["schemas"]["CreateRecruitPostingRequest"]);
    expect(created.status()).toBe(201);
    const draft = await created.json() as components["schemas"]["RecruitPosting"];
    const refused = await api(`/recruiting/postings/${draft.id}/publish`, "POST", {
      attest_exposure_scope: false, expected_updated_at: draft.updated_at,
    } satisfies components["schemas"]["PublishRecruitPostingRequest"]);
    expect(refused.status()).toBe(422);
    expect(refused.headers()["content-type"]).toContain("application/problem+json");
    expect(await refused.json()).toMatchObject({
      error: { code: "PREFLIGHT_FAILED", support_ref: expect.any(String) },
      checks: expect.arrayContaining([{ key: "exposure_attested", ok: false, note: expect.any(String) }]),
      publishable: false,
      status: 422,
    });
    expect(await (await api(`/recruiting/postings/${draft.id}`)).json()).toEqual({ posting: draft, applicants: [] });
  } finally {
    await page.context().close();
  }
});
