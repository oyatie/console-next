// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";

test.each([false, true])("one complete optional font keeps glyph geometry together (app config: %s)", async configured => {
  const temp = mkdtempSync(resolve("apps/web/.font-test-"));
  try {
    const input = resolve(temp, "index.html");
    writeFileSync(input, '<html><head></head><body><script type="module">import "/src/app.css"</script></body></html>');
    await build({ configFile: configured ? resolve("apps/web/vite.config.ts") : false, configLoader: "native", root: resolve("apps/web"), logLevel: "silent", build: { outDir: resolve(temp, "dist"), rollupOptions: { input } } });
    const dist = resolve(temp, "dist");
    const css = readdirSync(resolve(dist, "assets")).filter(f => f.endsWith(".css")).map(f => readFileSync(resolve(dist, "assets", f), "utf8")).join("\n");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(m => m[1]!).filter(face => face.includes("Pretendard Variable"));
    expect(faces).toHaveLength(1);
    for (const face of faces) {
      expect(face).toMatch(/font-display:optional/);
      expect(face).toMatch(/font-weight:45 920/);
      expect(face).not.toContain("unicode-range");
    }
    const html = readFileSync(resolve(dist, input.slice(resolve("apps/web").length + 1)), "utf8");
    expect([...html.matchAll(/rel="preload"[^>]*as="font"/g)]).toHaveLength(configured ? 1 : 0);
    if (configured) for (const face of faces) {
      const font = face.match(/url\(["']?([^"')]+)["']?\)/)![1]!;
      expect(html).toContain(`href="${font}"`);
    }
    expect(css).not.toContain("Pretendard Fallback");
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 30_000);
