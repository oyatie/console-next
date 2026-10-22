import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { idleOnServer, psql, settled, sinceServerInput } from "./idle-fixture";
import { tenantInSetup } from "./setup-flows";
import { box, revealUnit } from "./structure-flows";

// Idle sign-out (INF-03, decisions #8c, gate U17). The server's 30-minute minimum-5 timeout cannot be shortened
// from a test, so each path is reached with a real lever: a session ended elsewhere for the in-place re-auth, refused
// refreshes for "never sign out on a fault", the page clock for the warning (the server clamps a future
// X-Last-Interaction to its own now, so a page running ahead never ends or extends anything), and the server's own
// record of the last input moved back (e2e/idle-fixture.ts) for its cut-off.

/** The shell's one event stream (decision #27): it is never user activity, and it ends with the session. */
const STREAM = "/api/v1/events";

/** A fresh tenant (its identifier) and its signed-in first admin. */
async function tenantAdmin(browser: Browser, slug: string, name: string) {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(name);
  const id = unique(slug);
  await tenantSlugField(v).fill(id);
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  return { page: await firstSignIn(browser, await takeCode(v)), slug: id };
}
const admin = async (browser: Browser, slug: string, name: string) => (await tenantAdmin(browser, slug, name)).page;

/** Whether `text` was ever painted in `page` from now on, even for a frame. */
async function everPainted(page: Page, text: string) {
  let seen = false;
  await page.exposeFunction("__painted", () => void (seen = true));
  const watch = (t: string) =>
    new MutationObserver(() => {
      if (document.body?.textContent?.includes(t)) (window as unknown as { __painted: () => void }).__painted();
    }).observe(document, { subtree: true, childList: true, characterData: true });
  await page.addInitScript(watch, text);
  await page.evaluate(watch, text);
  return () => seen;
}

/** The session's own calls, from the page: the old bearer on a business read, and the cookie refresh. */
const replay = (page: Page, bearer: string) =>
  page.evaluate(async (authorization) => {
    const read = await fetch("/api/v1/users/me", { headers: { authorization } });
    const refresh = await fetch("/api/v1/auth/token/refresh", { method: "POST", headers: { "content-type": "application/json", "x-auth-transport": "cookie" }, body: "{}" });
    return { read: read.status, refresh: refresh.status, code: ((await refresh.json()) as { error?: { code?: string } }).error?.code };
  }, bearer);

test("a session that ends in use signs back in over the same screen, the draft intact", { tag: "@auth" }, async ({ browser }) => {
  const { admin: page } = await tenantInSetup(browser, "idleco", "유휴주식회사");

  // Every API request after real input carries that input's time (RFC 3339), which alone keeps the session alive.
  await go(page, "/org");
  await revealUnit(page, "본점");
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname.startsWith("/api/v1/") && "x-last-interaction" in r.headers());
  await page.keyboard.press("a");
  const field = page.getByRole("textbox", { name: /^본점 아래 새 부서 이름/ });
  await field.fill("총무부");
  await field.press("Enter");
  const stamp = Date.parse((await sent).headers()["x-last-interaction"]!);
  expect(Math.abs(stamp - Date.now())).toBeLessThan(60_000);
  await expect(box(page, "총무부")).toBeVisible();

  // A draft in progress: the next 부서 name typed in place on the chart (the add box stays open for it).
  await field.fill("임시 인사부");

  // The session ends server-side (here: signed out in another tab; an idle timeout ends it the same way).
  const other = await page.context().newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "로그아웃" }).click();
  await expect(other).toHaveURL(/\/login$/);
  await other.close();

  // The save is refused, and the user signs in again where they are: no trip to the sign-in screen.
  await field.press("Enter");
  const dialog = page.getByRole("dialog", { name: "다시 로그인" });
  await expect(dialog).toContainText("작성 중인 내용은 이 화면에 그대로 있으니");
  await expect(page).toHaveURL(/\/org/);
  await expectAccessible(page, "re-auth dialog");
  await dialog.getByRole("button", { name: "패스키로 다시 로그인" }).click();
  await expect(dialog).toBeHidden();
  await expect(field).toHaveValue("임시 인사부");
  await field.press("Enter");
  await expect(box(page, "임시 인사부")).toHaveCount(1);
});

test("a refresh that fails for a server fault or a dropped connection never signs anyone out", { tag: "@auth" }, async ({ browser }) => {
  const page = await admin(browser, "faultco", "장애주식회사");
  await settled(page); // the first screen done loading: a reload mid-navigation is aborted (Firefox)
  for (const fault of ["503", "network"] as const) {
    await page.route("**/api/v1/auth/token/refresh", (route) =>
      fault === "503" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "service_unavailable", message: "down" } }) }) : route.abort("connectionrefused"),
    );
    // A reload restores the session by refresh: with the server unreachable it says so, and stays signed in.
    await page.reload();
    await expect(page.getByRole("heading", { name: "화면을 표시하지 못했습니다" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await page.unroute("**/api/v1/auth/token/refresh");
    await page.getByRole("button", { name: "페이지 새로 고침" }).click();
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  }
});

test("two minutes before the idle cut-off a warning shows, and staying signed in clears it", { tag: "@auth" }, async ({ browser }) => {
  const page = await admin(browser, "warnco", "경고주식회사");
  // The timeout is the tenant's auth.idle_timeout_minutes (default 30), read from GET /api/v1/settings.
  const settings = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/settings" && r.ok());
  // The stream is open throughout: its opening, heartbeats and reconnects never count as input.
  const streamed = page.waitForResponse((r) => new URL(r.url()).pathname === STREAM && r.status() === 200);
  const streamHeaders: Record<string, string>[] = [];
  page.on("request", (r) => void (new URL(r.url()).pathname === STREAM && streamHeaders.push(r.headers())));
  await page.clock.install();
  await page.reload();
  await settings;
  await streamed;
  await page.keyboard.press("Shift"); // real input
  const warning = page.getByRole("alert").filter({ hasText: "자동으로 로그아웃됩니다" });

  await page.clock.fastForward("27:00");
  await page.clock.runFor(10_000);
  await expect(warning).toHaveCount(0);

  await page.clock.fastForward("01:30");
  await page.clock.runFor(10_000);
  await expect(warning).toBeVisible();
  await expectAccessible(page, "idle warning");

  expect(streamHeaders.length, "the stream was open").toBeGreaterThan(0);
  expect(streamHeaders.filter((h) => "x-last-interaction" in h), "the stream never reports input").toEqual([]);

  // The press reaches the server, carrying itself as the last input. (Regression, INTEG round 21: the warning
  // re-rendered on the press's pointerdown, removed its own button before the click, and nothing was sent.)
  // (The screen's own read of /users/me can land meanwhile without the header: only the request carrying input counts.)
  const stay = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/users/me" && r.request().method() === "GET" && "x-last-interaction" in r.request().headers());
  await warning.getByRole("button", { name: "로그인 유지" }).click();
  expect((await stay).status()).toBe(200);
  await expect(warning).toBeHidden();
  await expect(page).not.toHaveURL(/\/login/);
});

test("the event stream is not activity: an idle minute sends no request, and sign-out closes it and refuses its bearer", { tag: "@auth" }, async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await admin(browser, "streamco", "스트림주식회사");
  const sent: string[] = [];
  let bearer = "";
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname === STREAM) bearer = r.headers().authorization ?? "";
    if (pathname.startsWith("/api/")) sent.push(`${r.method()} ${pathname}`);
  });
  const streamed = page.waitForResponse((r) => new URL(r.url()).pathname === STREAM && r.status() === 200);
  await page.reload();
  await streamed;
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();

  // Walk gate (decision #27): with the stream open and no input, a minute passes without one request: no poll,
  // no keep-alive, no reconnect. (The screen's own first reads land first, however slow the engine.)
  await settled(page);
  const idle = sent.length;
  await page.waitForTimeout(60_000);
  expect(sent.slice(idle), "requests in an idle minute").toEqual([]);

  // Signing out closes the stream, and the signed-out bearer no longer opens one (BW-24 / INF-03).
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
  const out = sent.length;
  const refused = await page.request.get(STREAM, { headers: { authorization: bearer, accept: "text/event-stream" }, timeout: 10_000 });
  expect(refused.status()).toBe(401);
  await page.waitForTimeout(3_000); // past the stream's first reconnect backoff
  expect(sent.slice(out).filter((r) => r.endsWith(STREAM)), "no stream after sign-out").toEqual([]);
});

test("half an hour of typing with no save keeps reporting itself once a minute, and an idle half hour still warns first", { tag: "@auth" }, async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await admin(browser, "typeco", "입력주식회사");
  const settings = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/settings" && r.ok());
  await page.clock.install();
  await page.reload();
  await settings;
  const warning = page.getByRole("alert").filter({ hasText: "자동으로 로그아웃됩니다" });
  // The screen's own reads finish first: one still in flight after the first key would carry it too (Firefox).
  await settled(page);
  const pings: string[] = [];
  page.on("request", (r) => {
    const h = r.headers()["x-last-interaction"];
    if (new URL(r.url()).pathname === "/api/v1/users/me" && r.method() === "GET" && h) pings.push(h);
  });

  // Typing (keys with no request of their own) for 30 minutes: each minute's input reaches the server once, so the
  // server's idle cut (INF-03) never sees an idle session, and the warning never shows.
  for (let m = 0; m < 30; m++) {
    await page.keyboard.press("Shift");
    await page.clock.fastForward("01:00");
  }
  await page.clock.runFor(10_000);
  await expect(warning).toHaveCount(0);
  expect(pings.length, "one report a minute").toBeGreaterThanOrEqual(29);
  expect(pings.length, "never more than one a minute").toBeLessThanOrEqual(30);

  // Then nothing: no report without input (decision #27), and the warning comes before the cut-off. (The cut itself
  // is the server's, INF-03; refusing the signed-out stream is pinned above and in the backend's sse_session.)
  const idle = pings.length;
  await page.clock.fastForward("28:30");
  await page.clock.runFor(10_000);
  await expect(warning).toBeVisible();
  expect(pings.slice(idle), "nothing reported while idle").toEqual([]);
});

const WARNED = "자동으로 로그아웃됩니다";
const IDLE_OUT = "일정 시간 사용하지 않아 보안을 위해 로그아웃되었습니다";

test("in use past the timeout the session slides: input moves the server's record, and refresh rotates", { tag: "@auth" }, async ({ browser }) => {
  const { page, slug } = await tenantAdmin(browser, "slideco", "활동주식회사");
  // 29 of 30 minutes pass for the server, then real input: the requests it causes carry it, and the record moves.
  await idleOnServer(page, slug, 29);
  const carried = page.waitForResponse((r) => r.url().includes("/api/v1/") && "x-last-interaction" in r.request().headers() && r.ok());
  await page.getByRole("link", { name: "조직 구조" }).click();
  await carried;
  await expect(page).toHaveURL(/\/org$/);
  await expect.poll(() => sinceServerInput(slug), { message: "input slid the server's record" }).toBeLessThan(60);
  // Another 29: 58 minutes since sign-in, never 30 without input. A reload signs in again by refresh, which rotates.
  await idleOnServer(page, slug, 29);
  const rotated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/token/refresh");
  await page.reload();
  expect((await rotated).status()).toBe(200);
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});

test("idle past the timeout, a returning user signs in again at once, told why; nothing else gets through", { tag: "@auth" }, async ({ browser }) => {
  const { page, slug } = await tenantAdmin(browser, "awayco", "자리비움주식회사");
  const settings = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/settings" && r.ok());
  await page.clock.install();
  await page.reload();
  await settings;
  await settled(page);
  let bearer = "";
  page.on("request", (r) => void (r.headers().authorization && (bearer = r.headers().authorization!)));
  await page.keyboard.press("Shift"); // the last input
  const warned = await everPainted(page, WARNED);

  // Nobody uses it for 31 minutes: on the server, and in the tab (asleep, so its timers never ran).
  await idleOnServer(page, slug, 31);
  await page.clock.fastForward("31:00");
  await page.clock.runFor(1_000);
  const dialog = page.getByRole("dialog", { name: "다시 로그인" });
  await expect(dialog).toContainText(IDLE_OUT);
  await expect(dialog).toContainText("작성 중인 내용은 이 화면에 그대로 있으니");
  expect(warned(), "no warning naming a cut-off already past").toBe(false);
  await expectAccessible(page, "re-auth after idle");

  // Without signing in again nothing gets through: the old bearer, the refresh cookie (with its reason).
  expect(await replay(page, bearer)).toEqual({ read: 401, refresh: 401, code: "session_idle_expired" });
  await dialog.getByRole("button", { name: "패스키로 다시 로그인" }).click();
  await expect(dialog).toBeHidden();
  const read = page.waitForResponse((r) => r.url().includes("/api/v1/") && r.ok());
  await page.getByRole("link", { name: "조직 구조" }).click();
  await read;
});

test("a tab reloaded past the timeout lands on sign-in with the reason, and never paints a raw id or a past cut-off", { tag: ["@auth", "@regression"] }, async ({ browser }) => {
  const { page, slug } = await tenantAdmin(browser, "resumeco", "재개주식회사");
  await settled(page);
  await page.keyboard.press("Shift"); // remembered by the browser across the reload
  await idleOnServer(page, slug, 31);
  // A slow network: the screen catalog arrives late. (Regression: the warning painted idle.warn.body raw here, then
  // "will sign out at" a time hours gone, because the server never ended the session; the raw-id guard of
  // e2e/raw-id-guard.ts fails this spec on any raw id.)
  await page.route(/\/(catalogs\/ko\.ts|assets\/ko-[^/]*\.js)/, async (route) => {
    await new Promise((r) => setTimeout(r, 3_000));
    await route.continue();
  });
  const warned = await everPainted(page, WARNED);
  await page.clock.install({ time: Date.now() + 31 * 60_000 });
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(`${IDLE_OUT}. 다시 로그인하십시오.`)).toBeVisible();
  expect(warned()).toBe(false);
});

/** Read the committed ledger under the same tenant as the browser journey. */
function refreshAuditRows(slug: string) {
  const output = psql(slug, `SELECT COALESCE(json_agg(json_build_object(
    'action', action, 'source', source, 'outcome', outcome,
    'family_session', session_id = target_id::uuid)), '[]'::json)
    FROM audit_events WHERE org_id = current_setting('app.current_org')::uuid
    AND action IN ('auth.refresh', 'auth.logout', 'auth.refresh.reuse_detected');`);
  return JSON.parse(output.split("\n").find((line) => line.startsWith("["))!) as {
    action: string; source: string; outcome: string; family_session: boolean | null;
  }[];
}

test("refresh and logout commit allowed audit rows tied to their session family", { tag: ["@auth", "@regression"] }, async ({ browser }) => {
  const { page, slug } = await tenantAdmin(browser, "auditallow", "접속기록주식회사");
  const rotation = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/token/refresh");
  await page.reload();
  expect((await rotation).status()).toBe(200);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
  const rows = refreshAuditRows(slug);
  expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(["auth.refresh", "auth.logout"]));
  for (const row of rows) expect(row).toMatchObject({ source: "SYSTEM", outcome: "ALLOWED", family_session: true });
});

test("replaying a rotated refresh token commits a denied audit row for its session family", { tag: ["@auth", "@regression"] }, async ({ browser, request }) => {
  const { page, slug } = await tenantAdmin(browser, "auditreuse", "재사용기록주식회사");
  await settled(page);
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "console_refresh");
  expect(cookie).toBeDefined();
  const rotation = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/token/refresh");
  await page.reload();
  expect((await rotation).status()).toBe(200);
  const refused = await request.post(new URL("/api/v1/auth/token/refresh", page.url()).href, { data: { refresh_token: cookie!.value } });
  expect(refused.status()).toBe(401);
  const rows = refreshAuditRows(slug);
  const denied = rows.filter((row) => row.action === "auth.refresh.reuse_detected");
  expect(denied).toEqual([{ action: "auth.refresh.reuse_detected", source: "SYSTEM", outcome: "DENIED", family_session: true }]);
  for (const row of rows) expect(row.family_session).toBe(true);
});
