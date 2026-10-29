// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CSSOptions, Plugin } from "vite";

/** Catalog glyphs share one optional face; retain upstream subsets for other text. */
export function fontPolicy(): Plugin {
  const fonts = [resolve(import.meta.dirname, "src/generated/fonts/catalog.woff2")];
  const { family } = JSON.parse(readFileSync(resolve(import.meta.dirname, "src/generated/fonts/manifest.json"), "utf8"));
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
      return fonts.map(font => ({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "anonymous", "data-ui-font": family, href: building ? `/${Object.values(ctx.bundle!).find(asset => asset.type === "asset" && asset.names.includes(font.split("/").at(-1)!))!.fileName}` : `/@fs${font}` }, injectTo: "head" }));
    },
  };
}
