// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { AccountState } from "../states/account";
import { AT, failure, id, user } from "./fixtures";
import { mockRoute } from "./route";

export const accountReference = "0123456789abcdef0123456789abcdef";
/** Account-only reads and command failures layered over the shared shell. */
export async function accountReads(page: Page, state: AccountState) {
  const writes: unknown[] = [];
  const problem = { error: { ...failure(state === "save-403" ? "forbidden" : "internal").error, support_ref: accountReference, support_ref_at: AT } };
  await mockRoute(page, "get", "/api/v1/users/me", () => ({ status: 200, json: user }));
  await mockRoute(page, "get", "/api/v1/auth/passkeys", { status: 200, json: [{ id: id(10), label: "개인 패스키", created_at: AT, last_used_at: AT }] });
  await mockRoute(page, "get", "/api/v1/auth/passkeys/policy", { status: 200, json: { label_max_length: 80 } });
  const document = { version: "account-test", sha256: "a".repeat(64) };
  await mockRoute(page, "post", "/api/v1/auth/privacy-consent/status", { status: 200, json: { policy_version: document.version, accepted: true, accepted_at: AT, privacy: document, terms: document } });
  await mockRoute(page, "get", "/api/v1/onboarding/terms", { status: 200, json: { ...document, body: "이용 약관", privacy: { ...document, title: "개인정보 처리 안내", body: "개인정보 처리 안내 전문", published_on: AT.slice(0, 10), policy_url: "/privacy", review_pending: false } } });
  await mockRoute(page, "get", "/api/v1/tenant/ops-recovery", { status: 200, json: { request: null, state: null, recovery_available: false, ops_has_passkey: true, ops_enrolled: true, second_operator_available: false, active_accounts: 1, hold_hours: 24, code_ttl_minutes: 10 } });
  await mockRoute(page, "patch", "/api/v1/users/me", request => {
    writes.push(request.postDataJSON());
    return { status: 403, json: problem };
  });
  // Transport aborts and an undocumented internal 500 sit outside the generated response union.
  if (state === "save-500" || state === "save-network") await page.route("**/api/v1/users/me", route => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON());
      return state === "save-network" ? route.abort() : route.fulfill({ status: 500, json: problem });
    }
    if (state === "save-network" && writes.length > 0) return route.abort();
    return route.fallback();
  });
  return { writes };
}
