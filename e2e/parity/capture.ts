import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type CDPSession, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { authenticatorOf } from "../auth";

export const DESIGN = process.env.PARITY_DESIGN ?? "../console-design";
export const ROOT = process.env.PARITY_ROOT ?? "docs/design/regression/parity-2026-10-10";
export type Frame = { id: string; name: string; path: string; iteration: string; state: string; theme: string; width: number; height: number; golden: string[] };

export function vertical(f: Frame) {
  if (f.path.startsWith("frames/ideal/")) return f.path.split("/")[2]!;
  if (f.path.startsWith("frames/structure/")) {
    if (/^(P|S1-)/.test(f.name)) return "home-first-run";
    return /^S[345]-|^S2-registry/.test(f.name) ? "entities" : "org";
  }
  if (f.path.startsWith("frames/employee/")) return /^(H1-|P7-)/.test(f.name) ? "home-first-run" : "people";
  if (f.path.startsWith("frames/roles/")) return /^M(10|14|15)-/.test(f.name) ? "audit" : "access";
  return "attendance";
}

const manifest = JSON.parse(readFileSync(path.join(DESIGN, "manifest.json"), "utf8")) as { frames: Frame[] };
const latest = new Map<string, Frame>();
for (const f of manifest.frames) {
  if (!/^frames\/(ideal|structure|employee|attendance|roles)\//.test(f.path)) continue;
  const key = `${vertical(f)}/${f.name}`;
  if (!latest.has(key) || f.iteration > latest.get(key)!.iteration) latest.set(key, f);
}
export const frames = [...latest.values()];
expect(new Set(frames.map((f) => f.id)).size).toBe(frames.length);
const captureSessions = new WeakMap<Page, CDPSession>();

/** Original 2880px goldens were rendered at 1440 CSS px/DPR2; raised frames use DPR1. */
export async function capture(page: Page, v: string, names: string[], observation: string) {
  const selected = frames.filter((f) => vertical(f) === v && names.includes(f.name.replace(/--(dark|light|firefox|full|zoom200|z200|390|mobile|keyboard)/g, "")));
  expect(selected.length, `manifest frames for ${v}: ${names.join(", ")}`).toBeGreaterThan(0);
  mkdirSync(`${ROOT}/${v}`, { recursive: true });
  const keys = (await authenticatorOf(page).export()).length;
  let cdp = captureSessions.get(page);
  if (!cdp) { cdp = await page.context().newCDPSession(page); captureSessions.set(page, cdp); }
  for (const f of selected) {
    const scale = f.width === 2880 ? 2 : 1;
    await page.setViewportSize({ width: f.width / scale, height: f.height / scale });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: f.width / scale, height: f.height / scale, deviceScaleFactor: scale, mobile: false });
    await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, f.theme);
    await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom ? "2" : ""; }, /--(zoom200|z200)/.test(f.name));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.move(1, 1);
    await page.evaluate(() => document.fonts.ready);
    const file = `${f.id.replaceAll("/", "__")}.png`;
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const png = Buffer.from(data, "base64");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], f.id).toEqual([f.width, f.height]);
    writeFileSync(`${ROOT}/${v}/${file}`, png);
    writeFileSync(`node_modules/.cache/parity/${file}.json`, JSON.stringify({ frame: f.id, file: `${v}/${file}`, url: new URL(page.url()).pathname, observation, text: await page.locator("body").innerText() }));
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  // Detaching another page CDP session destroys Chromium's virtual passkeys; the page closes this session.
  expect((await authenticatorOf(page).export()).length, "capture preserves the admin's passkeys").toBe(keys);
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.locator("html").evaluate((el) => { el.dataset.theme = "light"; });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

/** Findings are evidence, not an assertion that the product already meets the ideal. */
export async function inspect(page: Page, v: string, scene: string) {
  const findings = [];
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, t) => { el.dataset.theme = t; }, theme);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    findings.push(...violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => ({ theme, rule: x.id, nodes: x.nodes.map((n) => n.target) })));
  }
  writeFileSync(`node_modules/.cache/parity/${v}-${scene}-axe.json`, JSON.stringify(findings));
  await page.locator("html").evaluate((el) => { el.dataset.theme = "light"; });
}
