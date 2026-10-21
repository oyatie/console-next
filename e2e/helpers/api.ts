import type { APIResponse, Page } from "@playwright/test";

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
export const apiOf = (page: Page, bearer: () => string) => (path: string, method = "GET", data?: object, headers: Record<string, string> = {}) =>
  page.request.fetch(`/api/v1${path}`, { method, headers: { authorization: bearer(), ...headers }, data, failOnStatusCode: false });

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
