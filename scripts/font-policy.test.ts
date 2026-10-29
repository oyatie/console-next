// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";

test("built optional subsets stay within the base font preload budget", async () => {
  const temp = mkdtempSync(resolve("apps/web/.font-test-"));
  try {
    const input = resolve(temp, "index.html");
    writeFileSync(input, '<html><head></head><body><script type="module">import "/src/app.css"</script></body></html>');
    await build({ configFile: resolve("apps/web/vite.config.ts"), configLoader: "native", root: resolve("apps/web"), logLevel: "silent", build: { outDir: resolve(temp, "dist"), rollupOptions: { input } } });
    const dist = resolve(temp, "dist");
    const css = readdirSync(resolve(dist, "assets")).filter(f => f.endsWith(".css")).map(f => readFileSync(resolve(dist, "assets", f), "utf8")).join("\n");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(m => m[1]!).filter(face => face.includes("Pretendard Variable"));
    // Keep all 92 optional faces for names outside the UI catalogs.
    expect(faces).toHaveLength(93);
    for (const face of faces) {
      expect(face).toMatch(/font-display:optional/);
      expect(face).toMatch(/font-weight:45 920/);
      expect(face).toContain("unicode-range");
    }
    const html = readFileSync(resolve(dist, input.slice(resolve("apps/web").length + 1)), "utf8");
    const preloads = [...html.matchAll(/<link\b[^>]*>/g)].filter(([link]) => /\brel="preload"/.test(link) && /\bas="font"/.test(link));
    expect(preloads).toHaveLength(1);
    expect(preloads[0]![0]).toContain("catalog");
    const catalog = faces.find(face => face.includes("catalog-"))!;
    expect(catalog).toContain("Pretendard Variable Catalog");
    expect(css).toContain("--font-catalog:");
    const bytes = preloads.reduce((sum, [link]) => sum + statSync(resolve(dist, link.match(/href="\/?([^"]+)"/)![1]!)).size, 0);
    // 95f8fae preloads three dynamic subsets (round8-proof/evidence.json).
    expect(bytes).toBeLessThanOrEqual(87_764);
    expect(css).not.toContain("Pretendard Fallback");
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
