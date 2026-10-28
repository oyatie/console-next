// SPDX-License-Identifier: LicenseRef-Proprietary
import { mediaQueries } from "./apps/web/src/ui/breakpoints.ts";

// CSS variables cannot be used in media conditions; expand the shared tokens before shipping CSS.
export default {
  plugins: [{
    postcssPlugin: "console-breakpoints",
    AtRule: { media(rule) {
      rule.params = rule.params.replace(/\(--([\w-]+)\)/g, (_, name) => {
        if (!Object.hasOwn(mediaQueries, name)) throw rule.error(`Unknown breakpoint: ${name}`);
        return mediaQueries[name];
      });
    } },
  }],
};
