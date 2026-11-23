// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog } from "@console/i18n";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type BrowserContext, type Page } from "./browser-test";

export type MountedGallery = {
  page: Page;
  close: () => Promise<void>;
};

export async function mountBrowserModule({
  slug,
  moduleCode,
  readySelector,
  lang = "ko",
  viewport,
}: {
  slug: string;
  moduleCode: string;
  readySelector: string;
  lang?: string;
  viewport?: { width: number; height: number };
}): Promise<MountedGallery> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    cacheDir: `.cache/${slug}`,
    logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      hmr: false,
      fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] },
    },
    plugins: [{
      name: slug,
      resolveId: id => (id === `/${slug}.js` ? `\0${slug}` : undefined),
      load: id => (id === `\0${slug}` ? moduleCode : undefined),
    }],
  });
  await server.listen();
  const browser: Browser = await browserEngine().launch();
  const context: BrowserContext = await browser.newContext(viewport ? { viewport } : undefined);
  const page: Page = await context.newPage();
  await page.route(`**/${slug}`, route => route.fulfill({
    contentType: "text/html",
    body: `<html lang="${lang}"><title>${slug}</title><div id="root"></div><script type="module" src="/${slug}.js"></script></html>`,
  }));
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}${slug}`, page.locator(readySelector));
  return {
    page,
    close: async () => {
      await page.close();
      await context.close();
      await browser.close();
      await server.close();
    },
  };
}

export async function mountGalleryEntry({
  name,
  entryPath,
  readySelector,
}: {
  name: string;
  entryPath: string;
  readySelector: string;
}): Promise<MountedGallery> {
  await loadCatalog("ko");
  return mountBrowserModule({
    slug: `${name}-gallery-test`,
    readySelector,
    moduleCode: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { loadCatalog } from '@console/i18n';
      import '/apps/web/src/app.css';
      import '/apps/web/src/gallery/gallery.css';
      await loadCatalog('ko');
      const { default: Gallery } = await import(${JSON.stringify(entryPath)});
      createRoot(document.getElementById('root')).render(React.createElement('main', null, React.createElement(Gallery)));
    `,
  });
}

export async function scanWcag22Matrix(
  page: Page,
  widths: readonly number[] = [1440, 390],
  height = 900,
): Promise<string[]> {
  const failures: string[] = [];
  for (const experience of ["baseline", "console"] as const) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of widths) {
        await page.setViewportSize({ width, height });
        await page.evaluate(([exp, thm]) => {
          document.documentElement.dataset.experience = exp;
          document.documentElement.dataset.theme = thm;
        }, [experience, theme] as const);
        const scan = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        for (const violation of scan.violations) {
          failures.push(`${experience} ${theme} ${width}px: ${violation.id} (${violation.help})`);
        }
      }
    }
  }
  return failures;
}
