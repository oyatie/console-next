import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { CACHE_DIR, PORTS } from "./slot";

// Faults injected between the browser and the backend (Playwright routes), and what the server recorded, read back
// over the API: the chaos specs assert what the user sees and that nothing was lost or recorded twice.

/** The catalog copy a command shows for a fault (packages/i18n boot.ts): no connection, or a server status. */
export const NETWORK_ERROR = "서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도하십시오.";
export const statusError = (status: number) => `서버가 요청을 처리하지 못했습니다(HTTP ${status}). 잠시 뒤 다시 시도하십시오.`;

/**
 * - `abort`: the request never reaches the server (connection refused).
 * - `lost`: the server records it, the answer never arrives (connection reset after it).
 * - `offline`: the connection drops as it is sent; the browser is offline until `online(page)`.
 * - `500`: the server answers 500 without recording (no error envelope).
 * - `slow`: the answer arrives after 5 s.
 */
export type Fault = "abort" | "lost" | "offline" | "500" | "slow";

/** Injects `fault` into the next `method` request whose path matches `url`; every other request goes through. */
export async function faultNext(page: Page, url: RegExp, fault: Fault, method = "POST") {
  let done = false;
  await page.route(url, async (r) => {
    if (done || r.request().method() !== method) return r.fallback();
    done = true;
    if (fault === "abort") return r.abort("connectionrefused");
    if (fault === "500") return r.fulfill({ status: 500, body: "" });
    if (fault === "offline") {
      await page.context().setOffline(true);
      return r.abort("internetdisconnected");
    }
    if (fault === "slow") await new Promise((ok) => setTimeout(ok, 5_000));
    if (fault !== "lost") return r.fallback();
    await r.fetch();
    return r.abort("connectionreset");
  });
}

export const online = (page: Page) => page.context().setOffline(false);

/**
 * Every `method` request to `url` the page sends, with the idempotency key it carried (the Idempotency-Key header,
 * or the `idempotency_key` body field of an employee registration).
 */
export function sent(page: Page, url: RegExp, method = "POST") {
  const keys: (string | undefined)[] = [];
  page.on("request", (r) => {
    if (r.method() !== method || !url.test(new URL(r.url()).pathname)) return;
    let key = r.headers()["idempotency-key"];
    try {
      key ??= (r.postDataJSON() as { idempotency_key?: string } | null)?.idempotency_key;
    } catch {
      // multipart or empty
    }
    keys.push(key);
  });
  return { count: () => keys.length, keys: () => new Set(keys) };
}

/**
 * The server's own answer to a read, as the signed-in user: the bearer token is the newest one the app itself sent
 * (it lives in memory only), so call this after the page has made at least one API request.
 */
export function apiAs(page: Page) {
  let bearer = "";
  page.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  return async <T>(path: string): Promise<T> => {
    expect(bearer, "the app has sent an authenticated request").not.toBe("");
    const res = await page.request.get(path, { headers: { authorization: bearer } });
    expect(res.status(), path).toBe(200);
    return (await res.json()) as T;
  };
}

/** A fresh tenant opened by the vendor and its first administrator, alone (no colleague, no entity yet). */
export async function soloTenant(browser: Browser, slug: string, name: string) {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(name);
  await tenantSlugField(v).fill(unique(slug));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  return firstSignIn(browser, await takeCode(v));
}

/**
 * This slot's backend, stopped (`up` false) or started again on the same database, through its own launcher
 * (scripts/backend-dev.mjs toggles its API process on SIGUSR2; its pid is in this slot's backend.json). Waits until
 * /readyz agrees (started) or the listener is gone (stopped). Never another slot's: the pid comes from this slot's
 * cache.
 */
export async function setBackend(up: boolean) {
  const { pid } = JSON.parse(readFileSync(path.join(CACHE_DIR, "backend.json"), "utf8")) as { pid: number };
  const ready = () => fetch(`http://127.0.0.1:${PORTS.backend}/readyz`).then((r) => r.ok, () => false);
  // Stopped means the listener is gone, not /readyz 503: a stopping backend drains first (/readyz 503 while it still
  // answers requests for its drain grace, BG-8/PR-10), so "not ready" alone would let a request land before the stop.
  const listening = () => fetch(`http://127.0.0.1:${PORTS.backend}/readyz`).then(() => true, () => false);
  if ((await ready()) === up) return;
  process.kill(pid, "SIGUSR2");
  await expect.poll(up ? ready : listening, { timeout: 60_000, intervals: [100, 250, 500] }).toBe(up);
}
