// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { glyphs } from "./fonts";

describe("screen font wait (JRN-FIRSTPAINT / J-HP-2)", () => {
  beforeAll(async () => {
    await loadCatalog(i18n.locale);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("glyphs() initiates background loading and caches promise by key", async () => {
    const fontLoadSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("document", { fonts: { load: fontLoadSpy } });

    const p1 = glyphs("test-key", () => "Sample text");
    const p2 = glyphs("test-key", () => "Sample text again");

    expect(p1).toBe(p2); // cached by key
    expect(fontLoadSpy).toHaveBeenCalledTimes(1);
    expect(fontLoadSpy).toHaveBeenCalledWith('1em "Pretendard Variable"', "Sample text");

    await p1;
  });

  it("glyphs() returns resolved promise when document or document.fonts is undefined", async () => {
    vi.stubGlobal("document", undefined);
    const p = glyphs("ssr", () => "text");
    await expect(p).resolves.toBeUndefined();
  });
});
