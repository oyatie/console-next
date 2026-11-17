// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

const resources = 'script[src], link[rel="stylesheet"], link[rel="modulepreload"]';
// Preview serves the built files; apply the production server's policy to the document.
const server = readFileSync(new URL("../../backend/app/src/spa.rs", import.meta.url), "utf8");
const policy = server.match(/const SPA_CSP: &str = "([\s\S]*?)";/)![1]!.replace(/\\\n\s*/g, "");

test.beforeAll(() => loadCatalog("ko"));

test.beforeEach(async ({ page }) => {
  await page.route(url => !url.pathname.startsWith("/api/") && !/\.[a-z0-9]+$/.test(url.pathname), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
  });
});

for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) test(`built assets have integrity and load under the production CSP: ${width}px ${theme}`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const fixture = await mockScreen(page, screens[0], "populated");
  const violations: string[] = [];
  page.on("console", message => {
    if (/content.security.policy|\bcsp\b/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    Object.assign(window, { cspViolations: [] as string[] });
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { cspViolations: string[] }).cspViolations.push(event.violatedDirective);
    });
  });
  const navigation = await page.goto("/");
  await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
  const assets = await page.evaluate(({ html, resources: selectors }) => Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll(selectors), element => ({
    url: element.getAttribute("src") ?? element.getAttribute("href")!,
    integrity: element.getAttribute("integrity"),
  })), { html: await navigation!.text(), resources });
  expect(assets.some(asset => asset.url.endsWith(".css"))).toBe(true);
  expect(assets.some(asset => asset.url.endsWith(".js"))).toBe(true);
  expect(await page.locator("script:not([src])").count()).toBe(0);
  for (const asset of assets) {
    expect(new URL(asset.url, page.url()).origin).toBe(new URL(page.url()).origin);
    const response = await request.get(asset.url);
    expect(response.ok()).toBe(true);
    expect(asset.integrity, asset.url).toBe(asset.url.startsWith("/assets/")
      ? `sha384-${createHash("sha384").update(await response.body()).digest("base64")}` : null);
  }
  await fits(page, `integrity ${width}px ${theme}`);
  const touchAction = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.setAttribute("data-react-aria-pressable", "");
    document.body.append(probe);
    const action = getComputedStyle(probe).touchAction;
    probe.remove();
    return action;
  });
  expect(["manipulation", "pan-x pan-y pinch-zoom"]).toContain(touchAction);
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(violations).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const [kind, selector] of [
  ["entry module", 'script[type="module"]'],
  ["stylesheet", 'link[rel="stylesheet"]'],
] as const) test(`the browser refuses a tampered ${kind}`, async ({ page, request }) => {
  const response = await request.get("/");
  const html = await response.text();
  const url = await page.evaluate(({ html: markup, selector: targetSelector }) => {
    const element = new DOMParser().parseFromString(markup, "text/html").querySelector(targetSelector)!;
    return element.getAttribute("src") ?? element.getAttribute("href")!;
  }, { html, selector });
  const fixture = await mockScreen(page, screens[0], "populated");
  let intercepted = false;
  await page.route(url, async route => {
    intercepted = true;
    await route.fulfill({ contentType: kind === "stylesheet" ? "text/css" : "text/javascript", body: kind === "stylesheet"
      ? ":root { --tampered-resource: executed; }"
      : "window.tamperedResource = true;" });
  });
  await page.goto("/");
  expect(intercepted).toBe(true);
  expect(await page.evaluate(() => ({
    script: (window as unknown as { tamperedResource?: boolean }).tamperedResource ?? false,
    style: getComputedStyle(document.documentElement).getPropertyValue("--tampered-resource").trim(),
  }))).toEqual({ script: false, style: "" });
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

for (const persistent of [false, true]) test(`mixed-release public scripts recover when the entry is ${persistent ? "still missing" : "missing once"}`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  const html = await (await request.get("/")).text();
  const scripts = await page.evaluate(markup => Array.from(
    new DOMParser().parseFromString(markup, "text/html").querySelectorAll('script[src]:not([type="module"])'),
    element => element.getAttribute("src")!), html);
  expect(scripts).toHaveLength(3);
  const fixture = await mockScreen(page, screens[0], "populated");
  const reports: { kind: string }[] = [];
  const documents: string[] = [];
  page.on("request", req => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documents.push(req.url());
    if (new URL(req.url()).pathname === "/api/v1/client-errors") reports.push(req.postDataJSON());
  });
  await page.route(url => scripts.includes(url.pathname), async route => {
    const response = await route.fetch();
    // Model the next release without changing these scripts' recovery behavior.
    await route.fulfill({ response, body: `${await response.text()}\n// next release\n` });
  });
  let entries = 0;
  await page.route(/\/assets\/index-[\w-]+\.js$/, route => {
    entries++;
    return documents.length === 1 || persistent
      ? route.fulfill({ status: 404, contentType: "text/javascript", body: "" }) : route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  if (persistent) {
    await expect(page.getByRole("heading", { name: t("common.crashed.title") })).toBeVisible();
    await expect(page.getByRole("button", { name: t("common.crashed.action"), exact: true })).toBeVisible();
  } else await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", "/");
  expect(documents).toHaveLength(2);
  expect(new URL(documents[1]!).searchParams.has("_r")).toBe(true);
  // Firefox can fetch the entry speculatively and again when the parser reaches it.
  expect(entries).toBeGreaterThanOrEqual(2);
  expect(reports.some(report => report.kind === "resource")).toBe(true);
  expect(await page.evaluate(() => {
    const recovery = window as unknown as { consoleChunkGuard?: object; consoleErrorBeacon?: object };
    return { guard: typeof recovery.consoleChunkGuard, beacon: typeof recovery.consoleErrorBeacon };
  })).toEqual({ guard: "object", beacon: "object" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("recovery.png"), fullPage: true });
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});
