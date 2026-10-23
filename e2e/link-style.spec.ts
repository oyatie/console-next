import { readdirSync, readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { go, kstDate, registerEmployee, vendorPage } from "./flows";
import { openUnit } from "./helpers/structure";
import { staffedTenant } from "./setup-flows";

// Live test (owner, 2026-10-07): raw anchors rendered the browser's own link style, blue, purple once visited and
// underlined. app.css now styles every `a` (design-language §5.4). This walk visits every route of the app shell
// and fails on any anchor in the browser's default look: the UA link or visited colour, or an underline at rest
// drawn in the text's own colour (the in-text link's resting underline is the soft --primary-bd, never currentColor).

const ROUTES = new URL("../apps/web/src/routes/", import.meta.url);
/** Every path the router declares, read from its source so a new screen is walked without editing this list. */
// A route that only redirects (`throw redirect(`, on its own line) is walked at its target; one whose screen renders a
// <Navigate> is walked too and checked where it lands.
const declared = readdirSync(ROUTES)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((f) => readFileSync(new URL(f, ROUTES), "utf8").split("\n").filter((l) => !l.includes("throw redirect(")))
  .flatMap((l) => [...l.matchAll(/path: "(\/[^"]*)"/g)].map((m) => m[1]!));
// Not shell screens: the sign-in pages are walked signed out below, the vendor console with the vendor, the
// passkey enrolment only exists mid sign-in, and the gallery is dev-only (visual.spec.ts audits it).
// A 발령 공고 exists only after a bulk batch; people-actions/notice.spec walks the notice page itself. An issued
// 증명서 exists only after issuance (its register opens rows, not links); certificates.spec walks and audits it.
const ELSEWHERE = new Set(["/login", "/setup-passkey", "/platform", "/_gallery", "/people/notices/$noticeId", "/people/certificates/$certificateId"]);
const statics = new Set(declared.filter((p) => !p.includes("$")));
/** A dynamic route's matcher: any value for its params, but never a static path (/people/new is not /people/$id). */
const pattern = (p: string) => {
  const re = new RegExp(`^${p.replace(/\$[A-Za-z]+/g, "[^/]+")}$`);
  return { test: (path: string) => re.test(path) && !statics.has(path) };
};

// The browsers' own link and visited colours: Chromium and WebKit light, Chromium dark (color-scheme: dark), Firefox dark.
const UA_COLOURS = ["rgb(0,0,238)", "rgb(85,26,139)", "rgb(158,158,255)", "rgb(208,173,240)", "rgb(140,140,255)", "rgb(255,173,255)"];

/** Anchors in the browser's default look on the current screen, in the light and the dark theme. */
async function rawAnchors(page: Page, where: string) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const found: string[] = [];
  const html = page.locator("html");
  const original = await html.getAttribute("data-theme");
  const anchors = await page.locator("a").count();
  for (const theme of ["light", "dark"]) {
    await html.evaluate((el, t) => (el.dataset.theme = t), theme);
    const bad = await page.evaluate((ua) => {
      const flat = (c: string) => c.replace(/\s+/g, "");
      return [...document.querySelectorAll("a")].flatMap((a) => {
        const s = getComputedStyle(a);
        const colour = flat(s.color);
        const what = `${a.textContent?.trim().slice(0, 30) || a.getAttribute("href")} (${colour}, ${s.textDecorationLine})`;
        if (ua.includes(colour)) return [`UA colour: ${what}`];
        if (s.textDecorationLine.includes("underline") && flat(s.textDecorationColor) === colour) return [`underline at rest: ${what}`];
        return [];
      });
    }, UA_COLOURS);
    found.push(...bad.map((b) => `[${theme}] ${where}: ${b}`));
    // Links read apart from the text around them (WCAG 1.4.1) and keep their contrast, in both themes.
    if (!anchors) continue;
    const { violations } = await new AxeBuilder({ page }).withRules(["link-in-text-block", "color-contrast"]).include("a").analyze();
    for (const v of violations) found.push(`[${theme}] ${where}: axe ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }
  await html.evaluate((el, t) => (t === null ? delete el.dataset.theme : (el.dataset.theme = t)), original);
  return found;
}

/**
 * In-app navigation to `path`, then waits for its screen: a fresh h1 (the last screen's stays while a lazy chunk loads;
 * a screen without an h1 of its own, such as the bulk move, moves on after 5 s) and a settled page.
 */
async function walkTo(page: Page, path: string) {
  await page.locator("h1").evaluateAll((hs) => hs.forEach((h) => h.setAttribute("data-walked", "")));
  await go(page, path, true);
  await expect(page.locator("h1:not([data-walked])").first()).toBeVisible({ timeout: 5_000 }).catch(() => {});
  await settled(page);
}

/** Two reads of the page 250 ms apart agree and nothing is busy, so links drawn from its reads are on it. */
async function settled(page: Page) {
  let last = "";
  await expect
    .poll(async () => {
      const now = await page.locator("body").innerHTML();
      const same = now === last && !now.includes('aria-busy="true"');
      last = now;
      return same;
    }, { intervals: [250] })
    .toBe(true);
}

test("no anchor on any route renders the browser's default link style", { tag: ["@smoke", "@regression"] }, async ({ browser }) => {
  test.setTimeout(900_000);
  const found: string[] = [];

  const out = await (await browser.newContext()).newPage();
  await out.goto("/login");
  await expect(out.locator("h1").first()).toBeVisible();
  found.push(...(await rawAnchors(out, "/login")));

  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await settled(vendor);
  found.push(...(await rawAnchors(vendor, "/platform")));

  const { admin } = await staffedTenant(browser, "links", "링크상사");
  const registration = admin.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/employees$/.test(r.url()));
  await registerEmployee(admin, { name: "한링크", number: "LK-0001", position: "사원" });
  const requestKey = (await registration).headers()["idempotency-key"]!;
  const person = new URL(admin.url()).pathname;
  // An exit case, so /people/exits/$id and the person page's exit block have their links.
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const sheet = admin.getByRole("dialog");
  await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(7));
  await sheet.getByLabel("퇴직 경위").fill("이직");
  await sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  await expect(sheet).toBeHidden();
  await expect(admin.getByRole("region", { name: "퇴직", exact: true })).toContainText("보고됨");
  // An org change (its record is /org/changes/$id) and a role (the roles list links /access/roles/$roleId).
  // The company structure chart (cs-chart) replaced the org tree's rows: the unit's box opens its panel.
  await (await openUnit(admin, "본사")).getByRole("button", { name: "부서 추가" }).click();
  const add = admin.getByRole("dialog", { name: "부서 신설" });
  await add.getByLabel("부서 이름").fill("총무부");
  await add.getByRole("button", { name: /^오늘/ }).click();
  await add.getByLabel("사유").fill("총무 기능 신설");
  await add.getByRole("button", { name: "부서 신설 1개 반영" }).click();
  // The user stays on the chart; the receipt links the change's record (org-19).
  await admin.getByRole("status").getByRole("link", { name: /^OC-\d{4}-\d{4} 기록 보기$/ }).click();
  await expect(admin).toHaveURL(/\/org\/changes\/[0-9a-f-]+/);
  const change = new URL(admin.url()).pathname;
  await go(admin, "/access/roles/new");
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill("링크 조회");
  await admin.getByRole("button", { name: "인사기본 조회" }).click();
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin).toHaveURL(/\/access\/roles$/);

  // Outcome lookup is a form, so walk its dynamic route through that entry as well as record links.
  await go(admin, "/requests");
  await admin.getByRole("textbox", { name: "요청 번호 또는 요청 키" }).fill(requestKey);
  await admin.getByRole("button", { name: "결과 확인" }).click();
  await expect(admin).toHaveURL(/\/requests\/[0-9a-f-]+$/);
  const outcome = new URL(admin.url()).pathname;

  // Static routes first; each dynamic route is reached through the first link on a walked screen that matches it.
  const shell = declared.filter((p) => !ELSEWHERE.has(p));
  const open = new Map(shell.filter((p) => p.includes("$")).map((p) => [p, pattern(p)]));
  const queue = [...shell.filter((p) => statics.has(p)), person, change, outcome];
  const walked = new Set<string>();
  while (queue.length) {
    const path = queue.shift()!;
    if (walked.has(path)) continue;
    walked.add(path);
    for (const [p, re] of open) if (re.test(path)) open.delete(p);
    await walkTo(admin, path);
    found.push(...(await rawAnchors(admin, path)));
    const hrefs = await admin.locator("a[href^='/']").evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
    for (const [p, re] of open) {
      const hit = hrefs.find((h) => re.test(h));
      if (!hit || queue.includes(hit)) continue;
      queue.push(hit);
      open.delete(p);
    }
  }
  expect([...open.keys()], "routes no walked screen linked to").toEqual([]);
  expect(found, found.join("\n")).toEqual([]);
});
