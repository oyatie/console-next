import { expect, type APIResponse, type Page } from "@playwright/test";
import type { components } from "@console/api/schema";
import { passkeyAssertion } from "../auth";
import { responseTimestampProblems, timestampContract } from "../../scripts/check-timestamp-display.mjs";

// The API as the signed-in page sends it, for negative tests: a refusal asserted at the server (status, code) and
// the read that proves nothing was written. Never used to build a world; worlds are made through the UI.

/** The bearer the page itself sends (kept in memory by the app); watch from before the first request you need. */
export function bearerOf(page: Page) {
  let bearer = "";
  page.on("request", (r) => {
    if (!r.url().includes("/api/v1/")) return;
    // A request still in flight when the test ends cannot read its headers any more; it carries nothing we need.
    r.allHeaders().then((h) => { if (h.authorization) bearer = h.authorization; }, () => {});
  });
  return () => bearer;
}

/** One call under the page's session: `api("/employees", "POST", body)`. */
export const apiOf = (page: Page, bearer: () => string) => async (path: string, method = "GET", data?: object, headers: Record<string, string> = {}) => {
  const endpoint = path.startsWith("/api/") ? path : `/api/v1${path}`;
  const response = await page.request.fetch(endpoint, { method, headers: { authorization: bearer(), ...headers }, data, failOnStatusCode: false });
  if (response.headers()["content-type"]?.includes("application/json")) {
    const problems = responseTimestampProblems(timestampContract, endpoint, method, response.status(), await response.json());
    if (problems.length) throw new Error(`${method} ${path}: ${problems.join(", ")}`);
  }
  return response;
};

/** A fresh assertion from the operator's enrolled passkey for API-only fixture setup. */
export async function stepUpAssertion(page: Page, api: ReturnType<typeof apiOf>): Promise<components["schemas"]["PasskeyStepUpAssertion"]> {
  await page.bringToFront();
  const response = await api("/auth/passkey/login/start", "POST", {});
  expect(response.status(), await response.text()).toBe(200);
  const ceremony = await response.json() as components["schemas"]["PasskeyLoginStartResponse"];
  return passkeyAssertion(page, { ...ceremony, challenge: { publicKey: ceremony.challenge.publicKey as PublicKeyCredentialRequestOptionsJSON } });
}

/** The error code of a refusal (`{error:{code}}`), or null for a success. */
export async function codeOf(res: Pick<APIResponse, "ok" | "json">) {
  if (res.ok()) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string }; code?: string };
  return body.error?.code ?? body.code ?? null;
}

/** How many people the roster holds, any status (one row read; the server counts). */
export async function headcount(api: ReturnType<typeof apiOf>) {
  return ((await (await api("/employees?limit=1")).json()) as { total: number }).total;
}
