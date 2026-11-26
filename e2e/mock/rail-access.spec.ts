// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { go } from "../flows";
import { openNav } from "../shell";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { screens } from "../states/registry";
import { screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const destination of ["/", "/org"]) for (const revoked of [false, true]) {
  test(`a held access ${revoked ? "revocation" : "grant"} waits for the next navigation from ${destination}`, async ({ page }, info) => {
    await page.addInitScript(recordShifts);
    const fixture = await mockScreen(page, screens[1], "empty");
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          const emit = () => controller.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"role","id":null}\n\n'));
          window.addEventListener("access-change", emit);
          request.signal.addEventListener("abort", () => { window.removeEventListener("access-change", emit); controller.close(); }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    });
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    let changed = false;
    const limited = screenAccess("/people");
    for (const entry of limited.entries) entry.scope.kind = "DEPARTMENT";
    // Both pages remain admitted; only the attendance and statutory links change.
    const org = screenAccess("/org");
    limited.entries.push(...org.entries);
    limited.decisions = { ...limited.decisions, ...org.decisions };
    const widened = { ...limited, entries: [...limited.entries, ...screenAccess("/attendance").entries, ...screenAccess("/statutory").entries],
      decisions: { ...limited.decisions, ...screenAccess("/attendance").decisions, ...screenAccess("/statutory").decisions } };
    await mockRoute(page, "get", "/api/v1/access/me", async () => {
      if (changed) { requested.resolve(); await held.promise; }
      return { status: 200, json: changed !== revoked ? widened : limited };
    });
    try {
      await go(page, "/people");
      const rail = page.getByRole("navigation", { name: t("shell.nav") });
      await expect(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      changed = true;
      await page.evaluate(() => window.dispatchEvent(new Event("access-change")));
      await requested.promise;
      const navigation = go(page, destination);
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      const snapshot = () => rail.getByRole("link").evaluateAll(links => links.map(link => ({
        to: link.getAttribute("href"), y: link.getBoundingClientRect().y,
      })));
      const before = await snapshot();
      const response = page.waitForResponse("**/api/v1/access/me");
      await page.evaluate(clearShifts);
      held.resolve();
      await (await response).finished();
      await navigation;
      await expectStable(page, "late access answer");
      const after = await snapshot();
      await info.attach("rail-entries", { body: JSON.stringify({ destination, revoked, before, after }), contentType: "application/json" });
      expect(after).toEqual(before);
      for (const label of ["shell.link.attendance", "shell.link.statutory"] as const) {
        await expect(rail.getByRole("link", { name: t(label), exact: true })).toHaveCount(revoked ? 1 : 0);
      }
      await go(page, "/people");
      for (const label of ["shell.link.attendance", "shell.link.statutory"] as const) {
        await expect(rail.getByRole("link", { name: t(label), exact: true })).toHaveCount(revoked ? 0 : 1);
      }
      await page.setViewportSize({ width: 390, height: 900 });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await openNav(page);
      await fits(page, "access snapshot dark phone");
      await page.screenshot({ path: info.outputPath("dark-phone.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });
}
