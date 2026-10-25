import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";
import type { clickCounter } from "./clicks";
import { expectAccessible } from "./a11y";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { CACHE_DIR } from "./slot";
import { readDevSecrets } from "../scripts/dev-secrets";
import { revealUnit } from "./structure-flows";
import { recordShifts } from "./stability";
import { guardConsole } from "./console-guard";
import { guardRawIds } from "./raw-id-guard";
import { fillRegister, openRegistered, pressRegister, receiptOf, registerSheet } from "./helpers/register";

let ipSeq = 0;
const contextOwners = new Map<BrowserContext, string>();
/**
 * A browser context with its own client address: X-Forwarded-For, which the backend honours only from its
 * configured trusted proxy (CONSOLE_TRUSTED_PROXY_*: Vite, or the browser itself on localhost). Every sign-in
 * then has its own per-IP rate-limit bucket, as distinct users do, instead of all tests sharing 127.0.0.1.
 */
export async function newContext(browser: Browser, contextOptions: Pick<BrowserContextOptions, "locale"> = {}) {
  const owner = test.info().testId;
  // Finished tests must not keep their sessions and event streams alive; the worker's vendor is reused.
  for (const [context, prior] of contextOwners) {
    if (prior !== owner && context !== vendor?.context()) await context.close();
  }
  const context = await browser.newContext({
    ...contextOptions,
    extraHTTPHeaders: { "x-forwarded-for": `10.${test.info().parallelIndex}.${process.pid % 256}.${(ipSeq = (ipSeq % 254) + 1)}` },
  });
  contextOwners.set(context, owner);
  context.on("close", () => contextOwners.delete(context));
  await context.addInitScript(recordShifts); // layout shifts from the first paint on (e2e/stability.ts)
  guardConsole(context); // React DOM-nesting errors fail the test (e2e/console-guard.ts)
  await guardRawIds(context); // a catalog id painted raw, even for a frame, fails the test (e2e/raw-id-guard.ts)
  return context;
}

/** The tenant slug was called a domain in current UI copy and an identifier on the shipped UI. */
export const tenantSlugField = (scope: Page | Locator) => scope.getByLabel(/(?:회사 )?도메인|식별자/);

/** The onboarding action belongs to its named modal, separate from the page opener. */
export const tenantOnboardSubmit = (page: Page) => page.getByRole("dialog", { name: "고객 계정 개설", exact: true }).getByRole("button", { name: "개설", exact: true });

// `audit`: run axe on the screens a helper passes through. Only the specs that test those screens
// (onboarding, recovery) pass true; everywhere else they are set-up steps.

/** Accepts required privacy notice and terms checkboxes unconditionally on /setup-passkey. */
export async function acceptConsent(page: Page) {
  const privacyCheck = page.getByRole("checkbox", { name: /개인정보 수집·이용/ });
  const termsCheck = page.getByRole("checkbox", { name: /서비스 이용약관/ });
  await expect(privacyCheck).toBeVisible();
  await expect(privacyCheck).toBeEnabled();
  await privacyCheck.press("Space");
  await expect(termsCheck).toBeEnabled();
  await termsCheck.press("Space");
}

/** Reveal the first-time code form before entering a code on /login. */
export async function openCodeSignIn(page: Page) {
  await page.locator("summary").filter({ hasText: "처음이면 일회용 코드" }).click();
  await expect(page.getByLabel("일회용 코드")).toBeVisible();
}

/** One-time code → passkey enrollment, as a first-time user does it. */
export async function firstSignIn(browser: Browser, code: string, keep?: string, audit = false, contextOptions: Pick<BrowserContextOptions, "locale"> = {}): Promise<Page> {
  // Own context (not browser.newPage()): axe opens a helper page in the same context.
  const page = await (await newContext(browser, contextOptions)).newPage();
  const authn = await virtualAuthenticator(page);
  await page.goto("/login");
  await openCodeSignIn(page);
  if (audit) await expectAccessible(page, "login");
  await page.getByLabel("일회용 코드").fill(code);
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  await acceptConsent(page);
  const enroll = page.getByRole("button", { name: /동의하고 패스키 등록|패스키 등록/, disabled: false });
  await expect(enroll).toBeVisible();
  if (audit) await expectAccessible(page, "setup passkey");
  await enroll.click();
  // Enrollment ends the code session and signs in with the new passkey.
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible({ timeout: 20_000 });
  if (keep) writeFileSync(keep, JSON.stringify(await authn.export()));
  return page;
}

/** Also used after link clicks or reloads when an absence assertion needs the destination's settled screen. */
export async function routeReady(page: Page, path?: string) {
  await page.waitForFunction(({ path }) => {
    const ready = document.querySelector<HTMLElement>("[data-route-ready]");
    return (!path || location.pathname === new URL(path, location.href).pathname)
      && ready?.dataset.routeReady === location.pathname + location.search + location.hash
      && ready.dataset.routeKey === history.state?.__TSR_key;
  }, { path });
}

/**
 * In-app navigation, as the app's own links do it (no reload). A reload re-runs the session refresh,
 * which the server rate-limits per session (60 a minute).
 * The router patches history.pushState, so pushing a path navigates; a page not yet in the app loads it.
 * RouteFrame marks the committed history entry ready after route loaders and the screen's active reads settle.
 */
export async function go(page: Page, path: string, mayRedirect = false) {
  if (!page.url().startsWith("http")) await page.goto(path);
  else {
    const to = new URL(path, page.url());
    await page.evaluate((href) => {
      const key = Math.random().toString(36).slice(2);
      history.pushState({ __TSR_index: ((history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0) + 1, key, __TSR_key: key }, "", href);
    }, to.href);
  }
  // `mayRedirect`: accept the rendered redirect destination, including a return to the starting pathname.
  await routeReady(page, mayRedirect ? undefined : path);
}

/**
 * Passkey sign-in from the login screen. The sign-in field's autofill (decisions #33) may sign in by itself on a fresh
 * page (Chromium's virtual authenticator answers a conditional request at once; after a sign-out in the tab it stays
 * paused). So: wait until the sign-in screen is up (or the autofill already left it), give the autofill a moment, else
 * press the button. Never trust a 로그아웃 still on screen from before the sign-out took effect.
 */
export async function passkeyLogin(page: Page) {
  const out = page.getByRole("button", { name: "로그아웃" }).first();
  const button = page.getByRole("button", { name: "패스키로 로그인" });
  const signedIn = async () => !new URL(page.url()).pathname.startsWith("/login") && (await out.isVisible());
  // The sign-in screen first: right after a sign-out click the old screen (and its 로그아웃) is still up. A fresh page's
  // autofill can only leave the screen after it rendered, so a missing button after this wait means it already did.
  await button.waitFor({ timeout: 10_000 }).catch(() => undefined);
  for (let i = 0; i < 15 && !(await signedIn()); i++) await page.waitForTimeout(200);
  if (!(await signedIn())) await button.click();
  await expect(out).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Reads the code a dialog shows exactly once, then closes it (an account code is "delivered", a tenant code is closed). */
export async function takeCode(page: Page, audit = false): Promise<string> {
  await expect(page.getByRole("dialog").filter({ has: page.getByLabel("일회용 코드") })).toBeVisible();
  if (audit) await expectAccessible(page, "one-time code dialog");
  const code = (await page.getByLabel("일회용 코드").textContent())!.trim();
  await page.getByRole("button", { name: /^(코드 전달 완료|코드 닫기)$/ }).click();
  return code;
}

// The cold-start code works once per database, so the vendor's passkey is kept for the other workers (and
// runs) on that database. scripts/backend-dev.mjs deletes it when it resets the database.
const CACHE = CACHE_DIR;
const VENDOR_PASSKEY = `${CACHE}/vendor-passkey.json`;
const VENDOR_LOCK = `${CACHE}/vendor-passkey.lock`;

/**
 * Runs `body` as the only user of the vendor's passkey across workers: the server refuses a signature counter
 * that does not move forward, so each use starts from the kept passkey and keeps the one it advanced.
 */
async function withVendorPasskey<T>(body: () => Promise<T>): Promise<T> {
  mkdirSync(CACHE, { recursive: true });
  for (;;) {
    try {
      mkdirSync(VENDOR_LOCK); // atomic: exactly one worker creates it
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // a worker killed while holding it leaves it behind; stolen after 120 s (no use takes that long).
      if (Date.now() - (statSync(VENDOR_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 120_000) rmSync(VENDOR_LOCK, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await body();
  } finally {
    rmSync(VENDOR_LOCK, { recursive: true, force: true });
  }
}
const readVendorPasskey = () => JSON.parse(readFileSync(VENDOR_PASSKEY, "utf8"));
const keepVendorPasskey = async (page: Page) => writeFileSync(VENDOR_PASSKEY, JSON.stringify(await authenticatorOf(page).export()));

let vendor: Page | null = null;
/** The platform vendor: bootstrapped once per database, then signs in with its passkey. */
export async function vendorPage(browser: Browser) {
  vendor ??= await withVendorPasskey(async () => {
    // Checked under the lock: a worker that waited out the cold start signs in with the passkey it kept.
    if (!existsSync(VENDOR_PASSKEY)) return firstSignIn(browser, readDevSecrets().coldstartOtp, VENDOR_PASSKEY);
    const page = await (await newContext(browser)).newPage();
    await (await virtualAuthenticator(page)).import(readVendorPasskey());
    await page.goto("/login");
    await passkeyLogin(page);
    await keepVendorPasskey(page);
    return page;
  });
  // A previous terms-publication journey also interrupts the shared vendor account.
  if (new URL(vendor.url()).pathname === "/setup-passkey") {
    await acceptConsent(vendor);
    await vendor.getByRole("button", { name: "동의하고 계속", exact: true }).click();
    await expect(vendor).not.toHaveURL(/\/setup-passkey$/);
  }
  return vendor;
}

/** A step-up with the vendor's passkey (e.g. a code reissue): `body` asserts it with the latest kept counter. */
export async function vendorStepUp<T>(body: () => Promise<T>): Promise<T> {
  const authn = authenticatorOf(vendor!);
  return withVendorPasskey(async () => {
    await authn.clear();
    await authn.import(readVendorPasskey());
    // Kept even when `body` fails: an assertion it made still advanced the counter the server holds, and a lost
    // count would refuse every later vendor sign-in as a cloned authenticator.
    try {
      return await body();
    } finally {
      await keepVendorPasskey(vendor!);
    }
  });
}


/** Chooses a radio card (ChoiceField) by its accessible name; the card, not the visually hidden input, takes the click. */
export const chooseRadio = (scope: Locator, name: RegExp) => scope.getByRole("radio", { name }).locator("xpath=ancestor::label[1]").click();

/** Clicks a dialog's command that first asks for the signed-in user's own passkey (step-up), and waits for `done`. */
export async function stepUp(dialog: Locator, button: string, done: Locator) {
  await dialog.getByRole("button", { name: button }).click();
  await expect(done).toBeVisible();
}

// E2E_REUSE=1 keeps the last run's database (playwright.config.ts): what must be unique gets this run's suffix.
const RUN = Date.now().toString(36);
// --repeat-each runs a spec again on the same database, so each repetition gets its own suffix too.
export const unique = (s: string) => {
  const r = test.info().repeatEachIndex;
  return `${s}${process.env.E2E_REUSE === "1" ? `-${RUN}` : ""}${r ? `-r${r}` : ""}`;
};

type Clicks = ReturnType<typeof clickCounter>;
export const plain = { click: (l: import("@playwright/test").Locator) => l.click(), select: (l: import("@playwright/test").Locator, v: string) => l.selectOption(v).then(() => undefined) };

/** The open proposal card (it takes the panel's place beside the tree or the tables). */
export const proposal = (page: Page) => page.getByRole("dialog").filter({ hasText: "아직 저장하지 않았습니다" });

/**
 * Completes the open proposal card and submits it for approval: the effective date is never defaulted, so the
 * card's 「오늘」 preset is one deliberate click (approveAndApply then applies it the same day).
 */
export async function propose(page: Page, reason: string, c: Pick<Clicks, "click"> = plain) {
  const card = proposal(page);
  await c.click(card.getByRole("button", { name: /^오늘/ }));
  await card.getByLabel("사유").fill(reason);
  // With 결재 (the tenant set approval.policy.org_structure = route) it is 「… 상신」 and waits at 결재 0/4; with none
  // (decisions #26, the default) it is 「… 반영」 and applies at once.
  await c.click(card.getByRole("button", { name: /(상신|반영)$/ }));
  await expect(page.locator('.rail-steps [aria-current="step"]')).toHaveText(/^(결재 0\/4|시행 )/);
}

/**
 * The executive opens the change from its Home row and approves every step on the change's decision card (A13: a
 * list row carries no decision); the drafter then effectuates it from Home. Each side loads Home afresh (a reload):
 * the other person's change is not in its cached lists. Nothing is read from the executive's Home after the last
 * approval, where a due change stays for every apply holder (A15).
 */
export async function approveAndApply(admin: Page, exec: Page, what: RegExp, consequence?: string, c: Pick<Clicks, "click"> = plain) {
  await exec.goto("/");
  await c.click(exec.getByRole("listitem").filter({ hasText: what }).getByRole("link").first());
  for (let i = 0; i < 4; i++) await decideStep(exec, c);
  await admin.goto("/");
  // Each row's button names its change ("교육팀 신설 시행"), so rows are told apart by name alone.
  await c.click(admin.getByRole("listitem").filter({ hasText: what }).getByRole("button", { name: what }));
  // The dialog says what effectuating does before it is done.
  if (consequence) await expect(admin.getByRole("dialog")).toContainText(consequence);
  await c.click(admin.getByRole("dialog").getByRole("button", { name: "조직 변경 시행" }));
  await expect(admin.getByRole("listitem").filter({ hasText: what })).toBeHidden();
}

/**
 * Approves the pending step on the open change page and waits until it is recorded. The page either re-offers the
 * next step's decision itself or, once a receipt shows, offers 「다음 단계(…) 결재 열기」 first. Each step's approve
 * button names its role and place ("인사 단계 승인 (1/4)"), so the recorded one is the one that is gone.
 */
export async function decideStep(page: Page, c: Pick<Clicks, "click"> = plain) {
  // Only the change page's decision card: Home's rows (still on screen while the record loads) carry approve too.
  const approve = page.getByRole("region", { name: "다음 할 일" }).getByRole("button", { name: / 단계 승인 \(\d\/\d\)$/ });
  const openNext = page.getByRole("button", { name: /^다음 단계.* 결재 열기$/ });
  await expect(approve.or(openNext).first()).toBeVisible();
  if (await openNext.isVisible()) await c.click(openNext);
  await expect(approve).toBeEnabled();
  const name = (await approve.textContent())!.trim();
  await c.click(approve);
  await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
}

/** One option of a segmented choice (React Aria radios: the label, not the hidden input, takes the click). */
export const option = (page: Page, group: string, name: string) => page.getByRole("radiogroup", { name: new RegExp(group) }).getByText(name, { exact: true });

/** `number` omitted: the server assigns the next one. */
export type NewEmployee = { name: string; number?: string; unit?: string; position?: string; hired?: string; contractEnd?: string };
/**
 * Registers an employee from their unit's panel (the 직원 등록 sheet opens over the roster with the unit chosen), then
 * opens their record from the roster by the 사번 the receipt names.
 */
export async function registerEmployee(admin: Page, e: NewEmployee, c: Pick<Clicks, "click" | "select"> = plain) {
  await submitRegistration(admin, e, c);
  await expect(receiptOf(admin, e.name)).toBeVisible();
  await openRegistered(admin, e.name, e.number);
  await expect(admin.getByRole("heading", { name: new RegExp(e.name), level: 1 })).toBeVisible();
}

export { registerSheet };

/** Fills the 직원 등록 sheet from the unit's row and presses 「등록하고 닫기」, without waiting for the record (it may be refused). */
export async function submitRegistration(admin: Page, e: NewEmployee, c: Pick<Clicks, "click" | "select"> = plain) {
  const unit = e.unit ?? "인사부";
  await go(admin, "/org");
  await revealUnit(admin, unit);
  await c.click(admin.getByRole("complementary", { name: unit, exact: true }).getByRole("link", { name: `${unit}에 직원 등록` }));
  await fillRegister(admin, { name: e.name, number: e.number, hired: e.hired ?? kstDate(), contractEnd: e.contractEnd }, c);
  if (e.position) await registerSheet(admin).getByRole("textbox", { name: /^직위/ }).fill(e.position);
  await pressRegister(admin, false, c);
}

/** How the app shows a YYYY-MM-DD business date in Korean ("2026. 10. 06."). */
export const koDate = (ymd: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${ymd}T00:00:00+09:00`));

/** A calendar date in Korea `days` from today, as YYYY-MM-DD. */
export const kstDate = (days = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
