// SPDX-License-Identifier: LicenseRef-Proprietary
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { cleanHeadingText, githubSlug, isSafeScheme } from "../lib/markdown";
import { SafeMarkdown } from "./safe-markdown";

describe("SafeMarkdown XSS neutralization and anchor slug parity", () => {
  test("githubSlug matches backend domain/src/runbook.rs slugification", () => {
    expect(githubSlug("Incident Triage & Rollback")).toBe("incident-triage--rollback");
    expect(githubSlug("Step 1: Verify_DB-01")).toBe("step-1-verify_db-01");
  });

  test("cleanHeadingText strips links, backticks, and nested/split HTML tags without reforming tags", () => {
    expect(cleanHeadingText('<a id="sec"></a> [Step 1](/alerts) `api`')).toBe(" Step 1 api");
    const nested = cleanHeadingText("<scr<script>ipt>Heading</script>");
    expect(nested).not.toContain("<");
    expect(nested).toContain("Heading");
  });

  test("isSafeScheme rejects javascript, data, vbscript, case-variant /API, and %2e traversal URIs", () => {
    expect(isSafeScheme("javascript:alert(1)")).toBe("unsafe");
    expect(isSafeScheme("  JaVa\tScRiPt:alert(1)")).toBe("unsafe");
    expect(isSafeScheme("data:text/html,<script>alert(1)</script>")).toBe("unsafe");
    expect(isSafeScheme("vbscript:msgbox(1)")).toBe("unsafe");
    expect(isSafeScheme("#step-1")).toBe("anchor");
    expect(isSafeScheme("docs/backup.md")).toBe("relative");
    expect(isSafeScheme("/docs/backup.md")).toBe("relative");
    expect(isSafeScheme("/alerts")).toBe("route");
    expect(isSafeScheme("/alerts?state=Firing#top")).toBe("route");
    expect(isSafeScheme("//evil.com/foo")).toBe("unsafe");
    expect(isSafeScheme("/\\evil.com")).toBe("unsafe");
    expect(isSafeScheme("/api/ops/v1/me")).toBe("unsafe");
    expect(isSafeScheme("/API/ops/v1/me")).toBe("unsafe");
    expect(isSafeScheme("/api")).toBe("unsafe");
    expect(isSafeScheme("/API")).toBe("unsafe");
    expect(isSafeScheme("/../secret")).toBe("unsafe");
    expect(isSafeScheme("/alerts/%2e%2e/api/ops/v1/me")).toBe("unsafe");
    expect(isSafeScheme("/%2e%2e/api")).toBe("unsafe");
    expect(isSafeScheme("/alerts/%2e%2e%2fapi/ops/v1/me")).toBe("unsafe");
    expect(isSafeScheme("..")).toBe("unsafe");
    expect(isSafeScheme("../secret.md")).toBe("unsafe");
    expect(isSafeScheme("docs/%2e%2e/secret.md")).toBe("unsafe");
    expect(isSafeScheme("https://ops.cosskorea.com/docs")).toBe("external");
  });

  test("SafeMarkdown preserves query and hash on route links and groups trailing punctuation with external URLs", async () => {
    const md = [
      "1. Inspect [Alerts](/alerts) and [Firing](/alerts?state=Firing#top) and [Probe](/docs/ops/xss-probe.md).",
      "2. Check [Backup doc](https://github.com/oyatie/console-infra/blob/main/RUNBOOK.md).",
      "3. Ignore [proto-rel](//evil.com/phish) and [upper api](/API/ops/v1/me) and [trav](/alerts/%2e%2e/api/ops/v1/me).",
    ].join("\n");
    const docsNav: string[] = [];
    const html = renderToStaticMarkup(
      createElement(SafeMarkdown, {
        content: md,
        onNavigateDoc: (doc) => docsNav.push(doc),
      }),
    );
    expect(html).toContain('href="/alerts"');
    expect(html).toContain('href="/alerts?state=Firing#top"');
    expect(html).not.toContain('href="//evil.com');
    expect(html).not.toContain('href="/API/ops/v1/me"');
    expect(html).not.toContain('href="/alerts/%2e%2e/api/ops/v1/me"');
    expect(html).toContain(">proto-rel<");
    expect(html).toContain(">upper api<");
    expect(html).toContain(">trav<");
    expect(html).toMatch(/externalTail.*<span[^>]*>\.<\/span>/);

    const root = createRootRoute({
      component: () => createElement(SafeMarkdown, { content: "[Firing](/alerts?state=Firing#top)" }),
    });
    const alerts = createRoute({
      getParentRoute: () => root,
      path: "/alerts",
      validateSearch: (raw: Record<string, unknown>) => ({
        state: typeof raw.state === "string" ? raw.state : undefined,
      }),
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([alerts]),
      history: createMemoryHistory({ initialEntries: ["/alerts"] }),
    });
    await router.load();
    const routerHtml = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(routerHtml).toContain('href="/alerts?state=Firing#top"');
  });

  test("SafeMarkdown processes pathological unclosed link/emphasis strings in linear O(N) time", () => {
    renderToStaticMarkup(createElement(SafeMarkdown, { content: "warmup" }));
    const pathological = `[a](${"a".repeat(5000)}X`;
    const t0 = performance.now();
    const html = renderToStaticMarkup(createElement(SafeMarkdown, { content: pathological }));
    const elapsedMs = performance.now() - t0;
    expect(html).toContain("[a](");
    expect(elapsedMs).toBeLessThan(20);

    const nestedUnclosed = `${"[a](".repeat(5000)})`;
    const t1 = performance.now();
    const nestedHtml = renderToStaticMarkup(createElement(SafeMarkdown, { content: nestedUnclosed }));
    const nestedMs = performance.now() - t1;
    expect(nestedHtml).toContain("[a](");
    expect(nestedMs).toBeLessThan(20);

    const emptyBracketsBeforeLink = `${"[]".repeat(5000)}[a](`;
    const t2 = performance.now();
    const emptyHtml = renderToStaticMarkup(createElement(SafeMarkdown, { content: emptyBracketsBeforeLink }));
    const emptyMs = performance.now() - t2;
    expect(emptyHtml).toContain("[]");
    expect(emptyMs).toBeLessThan(20);

    const unclosed = `${"[".repeat(1000)} ${"*".repeat(1000)}`;
    const unclosedHtml = renderToStaticMarkup(createElement(SafeMarkdown, { content: unclosed }));
    expect(unclosedHtml).toContain("[");
  });

  test("SafeMarkdown neutralizes hostile scripts, event handlers, iframes, and dangerous links", () => {
    const hostile = [
      "# Runbook Title",
      "",
      '<a id="safe-anchor"></a>',
      '<script>alert(1)</script>',
      '<img src="x" onerror="alert(1)">',
      '<svg onload="alert(1)">',
      '<iframe src="https://evil.invalid"></iframe>',
      "",
      "[bad js](javascript:alert(1))",
      "[bad data](data:text/html,<script>alert(1)</script>)",
      "[ext link](https://github.com/oyatie/console-infra)",
      "[section](#safe-anchor)",
    ].join("\n");

    const html = renderToStaticMarkup(createElement(SafeMarkdown, { content: hostile }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<[^>]+on\w+=/i);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toMatch(/<a[^>]+href="https?:/);
    expect(html).toContain('id="runbook-title"');
    expect(html).toContain('id="safe-anchor"');
    expect(html).toContain('href="#safe-anchor"');
    expect(html).toContain("https://github.com/oyatie/console-infra");
  });
});
