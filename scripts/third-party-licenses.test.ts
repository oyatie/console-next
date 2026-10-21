// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, it } from "vitest";
import { allowed, npmProd, render } from "./third-party-licenses.mjs";

describe("third-party-licenses", () => {
  it("evaluates SPDX expressions against the allow list", () => {
    expect(allowed("MIT")).toBe(true);
    expect(allowed("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(allowed("GPL-3.0-only")).toBe(false);
    expect(allowed("AGPL-3.0-only OR SSPL-1.0")).toBe(false);
    expect(allowed("MIT AND (Apache-2.0 OR GPL-2.0-only)")).toBe(true);
    expect(allowed("MIT AND GPL-2.0-only")).toBe(false);
    expect(allowed("NONE")).toBe(false);
  });

  it("takes production packages only, never dev or workspace links", () => {
    const lock = { packages: {
      "": { license: "UNLICENSED" },
      "node_modules/a": { version: "1.0.0", license: "MIT" },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
      "node_modules/vitest": { version: "4.0.0", license: "MIT", dev: true },
      "node_modules/@console/web": { link: true, resolved: "apps/web" },
    } };
    expect(npmProd(lock).map((d) => [d.name, d.license])).toEqual([["a", "MIT"], ["b", "NONE"]]);
  });

  it("renders every package, saying so when it ships no licence file", () => {
    const out = render([{ name: "x", version: "1.0.0", license: "MIT", dir: "/nonexistent" }]);
    expect(out).toContain("=== x 1.0.0 (MIT)");
    expect(out).toContain("no licence file in the package; see the SPDX text of MIT");
  });
});
