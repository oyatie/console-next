// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";
import { assetSecurity } from "../apps/web/asset-security.ts";

test.each(["/", "/console/"])("only content-addressed bootstrap assets are pinned with base %s", async base => {
  const root = mkdtempSync(resolve(tmpdir(), "asset-security-"));
  try {
    mkdirSync(resolve(root, "public"));
    writeFileSync(resolve(root, "index.html"), '<html><head><script src="/prefs.js"></script><script src="/guard.js"></script></head><body><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(resolve(root, "main.js"), 'import "./main.css"; document.body.dataset.booted = "true";');
    writeFileSync(resolve(root, "main.css"), 'body { color: red; }');
    writeFileSync(resolve(root, "public/guard.js"), 'window.guard = true;');
    const run = async (source: string) => {
      writeFileSync(resolve(root, "public/prefs.js"), source);
      const assetsDir = "built";
      await build({ root, base, build: { assetsDir }, configFile: false, logLevel: "silent", plugins: [assetSecurity()] });
      const html = readFileSync(resolve(root, "dist/index.html"), "utf8");
      const assets = [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map(([tag]) => {
        const url = tag.match(/\b(?:src|href)="([^"]+)"/)![1]!;
        const bytes = readFileSync(resolve(root, "dist", url.slice(base.length)));
        if (url.startsWith(`${base}${assetsDir}/`)) {
          expect(tag).toContain(`integrity="sha384-${createHash("sha384").update(bytes).digest("base64")}"`);
        } else expect(tag).not.toContain("integrity=");
        return { url, bytes: bytes.toString() };
      });
      const prefs = assets.find(asset => asset.url.includes("prefs"))!;
      expect(prefs.url).toBe(`${base}prefs.js`);
      expect(prefs.bytes).toBe(source);
      expect(assets.filter(asset => asset.url.startsWith(`${base}${assetsDir}/`)).map(asset => asset.url.split(".").at(-1)).sort()).toEqual(["css", "js"]);
      return assets;
    };
    const first = await run('window.theme = "light";');
    const second = await run('window.theme = "dark";');
    expect(second.find(script => script.url.includes("prefs"))!.url).toBe(first.find(script => script.url.includes("prefs"))!.url);
    expect(second.find(script => script.url.includes("guard"))!.url).toBe(first.find(script => script.url.includes("guard"))!.url);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
