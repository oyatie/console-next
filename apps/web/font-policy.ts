// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CSSOptions, Plugin } from "vite";

/** Use optional subsets; derive wordmark preloads from the shipped catalog. */
export function fontPolicy(): Plugin {
  const file = resolve(import.meta.dirname, "../../node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css");
  const boot = readFileSync(resolve(import.meta.dirname, "../../packages/i18n/src/catalogs/boot.ts"), "utf8");
  const text = [...boot.matchAll(/"app.name": "([^"\n]+)"/g)].map(m => m[1]).join("");
  if (!text) throw new Error("font policy: boot wordmark missing");
  const fonts = [...readFileSync(file, "utf8").matchAll(/@font-face\s*\{([^}]+)\}/g)]
    .filter(([, face]) => [...face!.matchAll(/U\+([\da-f]+)(?:-([\da-f]+))?/gi)].some(([, lo, hi]) =>
      [...text].some(c => c.codePointAt(0)! >= parseInt(lo!, 16) && c.codePointAt(0)! <= parseInt(hi ?? lo!, 16))))
    .map(([, face]) => resolve(dirname(file), face!.match(/url\(([^)]+)\)/)![1]!));
  const postcss: CSSOptions["postcss"] = { plugins: [{
    postcssPlugin: "optional-pretendard",
    AtRule: {
      "font-face": face => {
        let pretendard = false;
        face.walkDecls("font-family", d => { pretendard = d.value.includes("Pretendard Variable"); });
        if (pretendard) face.walkDecls("font-display", d => { d.value = "optional"; });
      },
    },
  }] };
  let building = false;
  return {
    name: "console-font-policy",
    config: () => ({ css: { postcss } }),
    configResolved: config => { building = config.command === "build"; },
    buildStart() {
      if (building) for (const font of fonts) this.emitFile({ type: "asset", name: font.split("/").at(-1)!, source: readFileSync(font) });
    },
    transformIndexHtml(_html, ctx) {
      return fonts.map(font => ({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "anonymous", href: building ? `/${Object.values(ctx.bundle!).find(asset => asset.type === "asset" && asset.names.includes(font.split("/").at(-1)!))!.fileName}` : `/@fs${font}` }, injectTo: "head" }));
    },
  };
}
