// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Hash files after Vite's preload rewriting, including copied public scripts. */
export function assetSecurity(): Plugin {
  let base: string;
  return {
    name: "console-asset-security",
    apply: "build",
    configResolved(config) { base = config.base; },
    writeBundle: {
      order: "post",
      handler(output, bundle) {
        for (const file of Object.keys(bundle).filter(candidate => candidate.endsWith(".html"))) {
          const path = resolve(output.dir!, file);
          // This stylesheet already contains React Aria's press rule; skip its duplicate inline injection.
          const source = readFileSync(path, "utf8").replace(/(<link\b[^>]*\brel="stylesheet")/, '$1 id="react-aria-pressable-style"');
          const html = source.replace(/<(script|link)\b[^>]*>/g, (tag: string, kind: string) => {
            if (kind === "link" && !/\brel="(?:stylesheet|modulepreload)"/.test(tag)) return tag;
            const url = tag.match(/\b(?:src|href)="([^"]+)"/)?.[1];
            if (!url) return tag;
            const bytes = readFileSync(resolve(output.dir!, url.slice(base.length)));
            const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
            return tag.replace(/\s*\/?>$/, ending => ` integrity="${integrity}"${ending}`);
          });
          writeFileSync(path, html);
        }
      },
    },
  };
}
