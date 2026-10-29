// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { prepareFonts, screen } from "./fonts";

beforeAll(() => loadCatalog(i18n.locale));
afterEach(() => vi.unstubAllGlobals());

test("a screen renders without forcing optional fonts to load during its first paint", async () => {
  const load = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("document", { fonts: { load } });
  const module = { screen: true };
  await expect(screen(() => Promise.resolve(module))()).resolves.toBe(module);
  expect(load).not.toHaveBeenCalled();
});

test("a screen import still reports its chunk failure", async () => {
  const error = new Error("screen unavailable");
  await expect(screen(() => Promise.reject(error))()).rejects.toBe(error);
});

test.each(["pending", "failed", "ready"])("the boot font is %s: choose its metrics once before rendering", async state => {
  const held = Promise.withResolvers<void>();
  const load = vi.fn(() => held.promise);
  const dataset: Record<string, string> = {};
  vi.stubGlobal("document", { querySelector: () => ({ href: "/catalog.woff2", dataset: { uiFont: "Pretendard Variable Catalog" } }), fonts: { load }, documentElement: { dataset } });
  vi.stubGlobal("performance", { getEntriesByName: () => state === "pending" ? [] : [{ entryType: "resource", responseEnd: 1 }] });
  let painted = false;
  const boot = prepareFonts().then(() => { painted = true; });
  await Promise.resolve();
  if (state !== "pending") {
    expect(painted).toBe(false);
    expect(load).toHaveBeenCalledExactlyOnceWith('1em "Pretendard Variable Catalog"');
  } else expect(load).not.toHaveBeenCalled();
  if (state === "failed") held.reject(new Error("invalid font")); else held.resolve();
  await boot;
  expect(painted).toBe(true);
  expect(dataset).toEqual(state === "ready" ? {} : { fontFallback: "" });
});
