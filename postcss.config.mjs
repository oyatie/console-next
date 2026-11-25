// SPDX-License-Identifier: LicenseRef-Proprietary
import { mediaQueries } from "./apps/web/src/ui/breakpoints.ts";

// CSS variables cannot be used in media conditions; expand the shared tokens before shipping CSS. This runs at the
// end, not as a media visitor: CSS Modules adds the CSS of a file that a module composes from after the visitors ran.
export default {
  plugins: [{
    postcssPlugin: "console-breakpoints",
    OnceExit(root) {
      root.walkAtRules("media", rule => {
        rule.params = rule.params.replace(/\(--([\w-]+)\)/g, (_, name) => {
          if (!Object.hasOwn(mediaQueries, name)) throw rule.error(`Unknown breakpoint: ${name}`);
          return mediaQueries[name];
        });
      });
    },
  }],
};
