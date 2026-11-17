// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

const resources = 'script[src], link[rel="stylesheet"], link[rel="modulepreload"]';
// Preview serves the built files; apply the production server's policy to the document.
const server = readFileSync(new URL("../../backend/app/src/spa.rs", import.meta.url), "utf8");
const policy = server.match(/const SPA_CSP: &str = "([\s\S]*?)";/)![1]!.replace(/\\\n\s*/g, "");

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
    expect(asset.integrity, asset.url).toBe(`sha384-${createHash("sha384").update(await response.body()).digest("base64")}`);
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
  ["public script", 'script[src="/prefs.js"]'],
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
  fixture.release();
});
