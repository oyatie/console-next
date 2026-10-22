// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup as html } from "react-dom/server";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

declare global {
  interface Window {
    renderUrl: (props: { href?: string; url?: string; className?: string }, locale?: string) => void;
    copies: string[];
    finishCopy: (ok: boolean) => void;
  }
}

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
const errors: string[] = [];

beforeAll(async () => {
  // On dev, exercise the existing hyperlink primitive so the negative control fails on behavior.
  const component = existsSync(resolve("apps/web/src/ui/external-url.tsx"))
    ? "import { ExternalUrl as Component } from '/apps/web/src/ui/external-url.tsx';"
    : "import { ExternalLink as Component } from '/apps/web/src/ui/external-link.tsx';";
  server = await createServer({
    configFile: false,
    cacheDir: ".cache/external-url-test",
    logLevel: "error",
    // No watcher or HMR: other suites write under the repo root, and a reload mid-case left the page without renderUrl.
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "external-url-test",
      resolveId: (id) => id === "/external-url-test.js" ? "\0external-url-test" : undefined,
      load: (id) => id === "\0external-url-test" ? `
        import { createElement, Fragment } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
        import { loadCatalog, i18n } from '@console/i18n';
        ${component}
        import { Announcer } from '/apps/web/src/ui/announcer.tsx';
        import { bindAnnouncer } from '/apps/web/src/lib/react/announce.ts';
        import '/apps/web/src/app.css';
        await Promise.all([loadCatalog('ko'), loadCatalog('en')]);
        const root = createRoot(document.getElementById('root'));
        // The shell's Announcer reads the route pathname, so it mounts inside a memory router here.
        const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/'] }) });
        window.renderUrl = (props, locale = 'ko') => {
          i18n.set(locale);
          flushSync(() => root.render(createElement(Fragment, null,
            createElement(Component, props, props.href),
            createElement(RouterContextProvider, { router }, createElement(Announcer, { bind: bindAnnouncer })),
          )));
        };
      ` : undefined,
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/external-url-test") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/external-url-test.js"></script>');
        });
      },
    }],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  errors.length = 0;
  await page.goto(`${origin}external-url-test`);
  await page.waitForFunction(() => typeof window.renderUrl === "function");
});

async function render(address: string, clipboardMode = "resolve", language = "ko") {
  await page.evaluate(({ href, mode, locale }) => {
    window.copies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: mode === "absent" ? undefined : {
        writeText: (text: string) => {
          window.copies.push(text);
          if (mode === "throw") throw new Error("Clipboard unavailable");
          if (mode === "reject") return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
          if (mode === "pending") return new Promise<void>((complete, reject) => {
            window.finishCopy = (ok) => ok ? complete() : reject(new Error("Permission denied"));
          });
          return Promise.resolve();
        },
      },
    });
    window.renderUrl({ href, className: "test-url" }, locale);
  }, { href: address, mode: clipboardMode, locale: language });
}

test("server rendering also keeps https inert", async () => {
  const href = "https://example.com/";
  let markup: string;
  if (existsSync(resolve("apps/web/src/ui/external-url.tsx"))) {
    const component = await import("./external-url");
    markup = html(<component.ExternalUrl href={href} />);
  } else {
    const component = await import("./external-link");
    markup = html(<component.ExternalLink href={href}>{href}</component.ExternalLink>);
  }
  expect(markup).not.toContain("<a ");
});

test("no anchors; only https offers Copy", async () => {
  for (const href of [
    "javascript:alert(1)", " java\tscript:alert(1)", "JaVaScRiPt:alert(1)",
    "data:text/html,<a href=x>x</a>", "http://example.com/insecure", "file:///local/file",
    "custom://host", "invalid-url", "", "https://", "//evil.test", "https://example.com/secure",
  ]) {
    await render(href);
    expect(await page.locator("a").count(), href).toBe(0);
    expect(await page.locator("button").count(), href).toBe(href.startsWith("https://example") ? 1 : 0);
    if (!href.startsWith("https://example")) expect(await page.locator("#root").textContent()).toBe(href);
  }
});

test.each([
  ["https://한국.com/test", "xn--3e0b707e.com"],
  ["https://рaypal.com/login", "xn--aypal-uye.com"],
  ["https://sub.domain.example.com/docs?ref=1#top", "example.com"],
  ["https://notice.law.go.kr/info", "law.go.kr"],
  ["https://secure.рaypal.com.evil.test./", "evil.test."],
  ["https://sub.한국.github.io/", "xn--3e0b707e.github.io"],
  ["https://sub.한국.blogspot.com/", "xn--3e0b707e.blogspot.com"],
  ["https://a.b.ck/", "a.b.ck"],
  ["https://sub.www.ck/", "www.ck"],
  ["https://127.0.0.1:8443/", "127.0.0.1"],
  ["https://[::1]:8443/", "[::1]"],
  ["https://localhost/", "localhost"],
])("punycode and registrable domain: %s", async (href, domain) => {
  await render(href);
  expect(await page.locator("strong").textContent()).toBe(domain);
  expect(await page.locator("#root > span > span").first().textContent()).toBe(new URL(href).href);
  expect(await page.locator(".test-url").count()).toBe(1);
  await page.getByRole("button").click();
  expect(await page.evaluate(() => window.copies)).toEqual([new URL(href).href]);
});

test.each([
  "https://example.com/?",
  "https://example.com/#",
  "https://example.com/?#",
  "https://billing:secret@sub.한국.com:8443/account?#",
])("shows empty query and fragment delimiters that Copy includes: %s", async (href) => {
  await render(href);
  await page.getByRole("button").click();
  expect(await page.evaluate(() => window.copies)).toEqual([new URL(href).href]);
  expect(await page.locator("#root > span > span").first().textContent()).toBe(new URL(href).href);
});

test.each([
  "https://billing:secret@example.com/account",
  "https://billing@example.com/account",
  "https://:secret@example.com/account",
  "https://bill%40ing:sec%3Aret@sub.한국.com:8443/account",
])("shows userinfo that Copy includes: %s", async (href) => {
  await render(href);
  expect(await page.locator("#root > span > span").first().textContent()).toBe(new URL(href).href);
  expect(await page.locator("strong").textContent()).toBe(new URL(href).hostname.replace(/^sub\./, ""));
  await page.getByRole("button").click();
  expect(await page.evaluate(() => window.copies)).toEqual([new URL(href).href]);
});

test.each([
  ["ko", "주소 복사", "주소를 복사했습니다"],
  ["en", "Copy address", "Address copied"],
])("Copy writes the displayed address and announces feedback (%s)", async (locale, label, copied) => {
  const href = "https://sub.한국.com:8443/경로?a=1#top";
  await render(href, "resolve", locale);
  const button = page.getByRole("button", { name: label, exact: true });
  expect(await button.getAttribute("type")).toBe("button");
  expect(await button.getAttribute("class")).toContain("btn--icon");
  expect(await page.getByRole("status").count()).toBe(1);
  expect(await page.locator(".test-url [role=status]").count()).toBe(0);
  await button.click();
  expect(await page.evaluate(() => window.copies)).toEqual([new URL(href).href]);
  await expect.poll(() => page.getByRole("status").textContent()).toBe(copied);
  expect(await button.getAttribute("aria-label")).toBe(label);
  expect(await button.getAttribute("title")).toBe(label);
  await button.click();
  expect(await page.evaluate(() => window.copies)).toEqual([new URL(href).href, new URL(href).href]);
  await expect.poll(() => page.getByRole("status").textContent()).toBe(copied);
  expect(await button.getAttribute("aria-label")).toBe(label);
});

for (const [locale, label, failed] of [
  ["ko", "주소 복사", "주소를 복사하지 못했습니다. 주소를 선택해 직접 복사하십시오."],
  ["en", "Copy address", "Couldn’t copy the address. Select it and copy it yourself."],
]) {
  test.each(["absent", "reject", "throw"])(`${locale} clipboard %s reports failure without success or unhandled errors`, async (mode) => {
    await render("https://example.com/", mode, locale);
    await page.getByRole("button").click();
    await expect.poll(() => page.getByRole("status").textContent()).toBe(failed);
    expect(await page.getByRole("button").getAttribute("aria-label")).toBe(label);
    expect(errors).toEqual([]);
  });
}

test.each([true, false])("older copy completion cannot overwrite newer feedback (latest success: %s)", async (latestSucceeded) => {
  await render("https://example.com/", "pending");
  await page.getByRole("button").click();
  const firstCopy = await page.evaluateHandle(() => window.finishCopy);
  await page.getByRole("button").click();
  await page.evaluate((ok) => window.finishCopy(ok), latestSucceeded);
  const label = "주소 복사";
  const status = latestSucceeded ? "주소를 복사했습니다" : "주소를 복사하지 못했습니다. 주소를 선택해 직접 복사하십시오.";
  await expect.poll(() => page.getByRole("button").getAttribute("aria-label")).toBe(label);
  await expect.poll(() => page.getByRole("status").textContent()).toBe(status);
  await firstCopy.evaluate((finish, ok) => finish(ok), !latestSucceeded);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect.poll(() => page.getByRole("button").getAttribute("aria-label")).toBe(label);
  expect(await page.getByRole("status").textContent()).toBe(status);
  expect(errors).toEqual([]);
  await firstCopy.dispose();
});

test.each([true, false])("changing the URL ignores an old pending copy (success: %s)", async (succeeded) => {
  await render("https://one.example/", "pending");
  await page.getByRole("button").click();
  await page.evaluate((ok) => {
    window.renderUrl({ href: "https://two.example/" });
    window.finishCopy(ok);
  }, succeeded);
  // Let the shared announcer's animation frame run before checking for stale feedback.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.getByRole("status").textContent()).toBe("");
  expect(await page.getByRole("button").getAttribute("aria-label")).toBe("주소 복사");
  await page.evaluate(() => window.renderUrl({ href: "https://one.example/" }));
  expect(await page.getByRole("button").getAttribute("aria-label")).toBe("주소 복사");
  expect(errors).toEqual([]);
});

test.each(["https:", "http:", "javascript:"])("long %s URLs reflow at 320 px", async (scheme) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await render(`${scheme}//example.com/${"long".repeat(100)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await page.locator(".test-url").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
});

test("url alias works and href takes precedence", async () => {
  await render("https://first.example/");
  await page.evaluate(() => window.renderUrl({ url: "https://alias.example/" }));
  expect(await page.getByRole("button").count()).toBe(1);
  await page.getByRole("button").click();
  expect(await page.evaluate(() => window.copies)).toEqual(["https://alias.example/"]);
  await page.evaluate(() => window.renderUrl({ href: "https://chosen.example/", url: "https://ignored.example/" }));
  expect(await page.locator("#root > span > span").first().textContent()).toBe("https://chosen.example/");
});
