// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import postcss from "../../postcss.config.mjs";

const backend = process.env.CONSOLE_BACKEND ?? "http://127.0.0.1:8090";

function assetSecurity(): Plugin {
  let base: string;
  let assetsDir: string;
  return {
    name: "ops-asset-security",
    apply: "build",
    configResolved(config) {
      base = config.base;
      assetsDir = config.build.assetsDir;
    },
    writeBundle: {
      order: "post",
      handler(output, bundle) {
        for (const file of Object.keys(bundle).filter((candidate) => candidate.endsWith(".html"))) {
          const filePath = resolve(output.dir!, file);
          const source = readFileSync(filePath, "utf8").replace(
            /(<link\b[^>]*\brel="stylesheet")/i,
            '$1 id="react-aria-pressable-style"',
          );
          const html = source.replace(/<(script|link)\b[^>]*>/gi, (tag: string, kind: string) => {
            if (kind.toLowerCase() === "link" && !/\brel="(?:stylesheet|modulepreload)"/i.test(tag)) return tag;
            const url = tag.match(/\b(?:src|href)="([^"]+)"/i)?.[1];
            if (!url || (!url.startsWith(`${base}${assetsDir}/`) && url !== `${base}prefs.js`)) return tag;
            const bytes = readFileSync(resolve(output.dir!, url.slice(base.length)));
            const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
            return tag.replace(/\s*\/?>$/, (ending) => ` integrity="${integrity}"${ending}`);
          });
          writeFileSync(filePath, html);
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), assetSecurity()],
  css: { postcss },
  build: {
    assetsInlineLimit: 0,
    manifest: true,
  },
  cacheDir: resolve(import.meta.dirname, `../../.cache/vite-ops-${process.env.CONSOLE_OPS_PORT ?? "dev"}`),
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
    port: Number(process.env.CONSOLE_OPS_PORT ?? 5174),
    strictPort: true,
    proxy: {
      "/api": { target: backend },
    },
  },
});
