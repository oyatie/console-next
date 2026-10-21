// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { go } from "./flows";
import { tenantInSetup } from "./setup-flows";
import { box, revealUnit } from "./structure-flows";

// This focused E2E runs with a 3-minute server-issued access token; it never moves the browser clock.

const STREAM = "/api/v1/events";
const REFRESH = "/api/v1/auth/token/refresh";
const EXPIRY_PROBE = "x-e2e-expiry-probe";

function tokenExpiry(authorization: string): number {
  const payload = authorization.replace(/^Bearer\s+/, "").split(".")[1];
  if (!payload) throw new Error("stream authorization is not a JWT");
  const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number }).exp;
  if (typeof exp !== "number") throw new Error("stream access token has no exp claim");
  return exp;
}

async function addDepartment(page: Page, name: string) {
  await go(page, "/org");
  await revealUnit(page, "본점");
  await page.keyboard.press("a"); // add a 부서 under the selected unit
  const field = page.getByRole("textbox", { name: /^본점 아래 새 부서 이름/ });
  await field.fill(name);
  await field.press("Enter");
  await expect(box(page, name)).toBeVisible();
}

test("a stream renews before server expiry, rejects its old bearer, and keeps changes arriving", { tag: "@live" }, async ({ browser }) => {
  test.setTimeout(420_000);
  const { admin: page } = await tenantInSetup(browser, "renewco", "갱신주식회사");
  const streams: { status: number; bearer: string; at: number; serverAt: number }[] = [];
  const refreshes: { status: number; at: number }[] = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    const headers = r.request().headers();
    if (path === STREAM && headers[EXPIRY_PROBE] !== "1")
      streams.push({
        status: r.status(),
        bearer: headers.authorization ?? "",
        at: Date.now(),
        serverAt: Date.parse(r.headers().date ?? ""),
      });
    if (path === REFRESH) refreshes.push({ status: r.status(), at: Date.now() });
  });
  await go(page, "/org");
  const opened = page.waitForResponse((r) => new URL(r.url()).pathname === STREAM && r.ok());
  await page.reload();
  await opened;
  await revealUnit(page, "본점");
  const initial = streams.find((s) => s.status === 200);
  expect(initial?.bearer, "the live stream carries its access token").toBeTruthy();
  const first = initial!.bearer;
  const expiresAtServer = tokenExpiry(first) * 1000;
  const initialLifetime = expiresAtServer - initial!.serverAt;
  expect(initialLifetime, "the E2E server issued a 180-second token").toBeGreaterThan(120_000);
  expect(initialLifetime, "the E2E server issued a 180-second token").toBeLessThanOrEqual(180_000);
  const expiresAt = initial!.at + initialLifetime;
  const before = refreshes.length;

  const beforeExpiry = Math.max(1_000, expiresAt - Date.now() - 1_000);
  await expect.poll(
    () => refreshes.slice(before).some((r) => r.status === 200 && r.at < expiresAt),
    { message: "the server-issued token renewed before exp", timeout: beforeExpiry, intervals: [250, 500, 1_000] },
  ).toBe(true);
  await expect.poll(
    () => streams.some((s) => s.status === 200 && s.bearer !== first && s.at < expiresAt),
    { message: "the stream reopened with the renewed token before exp", timeout: beforeExpiry, intervals: [250, 500, 1_000] },
  ).toBe(true);

  // Wait on real time until the first JWT has expired on the server, then verify the server's expired-token refusal.
  // Keep this timer outside the page: Firefox can abort a long page-side timer while its SSE document is active.
  await delay(Math.max(0, expiresAt - Date.now() + 5_000));
  // Use the runner's HTTP client for the probe: Firefox can queue a fetch behind the page's long-lived SSE
  // connection, and reading JSON from an unexpected 200 SSE response would wait forever for the stream to end.
  const response = await fetch(new URL(STREAM, page.url()), {
    headers: { authorization: first, accept: "text/event-stream", [EXPIRY_PROBE]: "1" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = response.status === 401
    ? await response.json().catch(() => null) as { error?: { code?: string } } | null
    : null;
  const expired = { status: response.status, code: body?.error?.code };
  await response.body?.cancel().catch(() => undefined);
  expect(expired).toEqual({ status: 401, code: "token_expired" });

  // Still live on the new token: a department added in another tab reaches this screen with no reload.
  const other = await page.context().newPage();
  await addDepartment(other, "갱신부");
  await page.bringToFront(); // Firefox can pause a background tab's streaming fetch until the person returns to it.
  await expect(box(page, "갱신부")).toBeVisible({ timeout: 45_000 });
  expect(streams.filter((s) => s.status === 401), "no stream request was refused").toEqual([]);
  expect(refreshes.filter((r) => r.status !== 200), "every renewal succeeded").toEqual([]);
});
