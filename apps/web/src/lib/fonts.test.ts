// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { screen } from "./fonts";

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
