// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mountBrowserModule, mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "decision-pane",
    entryPath: "/apps/web/src/ui/decision-pane/decision-pane.gallery.tsx",
    readySelector: "[data-decision-pane-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("DecisionPane passes WCAG 2.2 AA axe checks, requires a comment on reject while allowing empty approve", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.getByRole("button", { name: t("uiWorklist.reject"), exact: true }).click();
  const alert = page.locator('[data-decision-pane] [role="alert"]');
  expect(await alert.textContent()).toContain(t("uiWorklist.opinionRequired"));

  await page.getByRole("button", { name: t("uiWorklist.approve"), exact: true }).click();
  expect(await page.locator("[data-decision-pane-gallery]").getAttribute("data-outcome")).toBe("approved");

  await page.locator("[data-decision-pane] input").fill("Memo");
  await page.getByRole("button", { name: t("uiWorklist.reject"), exact: true }).click();
  expect(await page.locator("[data-decision-pane-gallery]").getAttribute("data-outcome")).toBe("rejected");
});

describe("DecisionPane narrow wrap and resetKey", () => {
  let narrow: MountedGallery;

  beforeAll(async () => {
    narrow = await mountBrowserModule({
      slug: "decision-pane-narrow-test",
      lang: "en",
      readySelector: "[data-decision-pane]",
      viewport: { width: 1440, height: 900 },
      moduleCode: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { DecisionPane } from '/apps/web/src/ui/decision-pane/decision-pane.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('en');
        function Harness() {
          const [itemId, setItemId] = useState('item-1');
          const [opinion, setOpinion] = useState('');
          return React.createElement('main', null,
            React.createElement('button', { type: 'button', 'data-switch': '', onClick: () => setItemId('item-2') }, 'Switch'),
            React.createElement('div', { 'data-narrow-pane': '', style: { width: '280px', padding: '12px' } },
              React.createElement(DecisionPane, {
                resetKey: itemId,
                opinion,
                onOpinionChange: setOpinion,
                onApprove: () => undefined,
                onReject: () => undefined,
                onReturn: () => undefined,
              }),
            ),
          );
        }
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
      `,
    });
  }, 60_000);

  afterAll(async () => {
    await narrow?.close();
  });

  test("wraps action buttons inside 280px warm-clear EN without horizontal overflow and clears alert on resetKey", async () => {
    const { page } = narrow;
    await page.evaluate(() => {
      document.documentElement.dataset.experience = "warm-clear";
      document.documentElement.dataset.theme = "light";
    });
    const sizes = await page.evaluate(() => {
      const actions = document.querySelector("[data-decision-pane] > div:last-child") as HTMLElement;
      return { scrollWidth: actions.scrollWidth, clientWidth: actions.clientWidth };
    });
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);

    await page.getByRole("button", { name: "Reject", exact: true }).click();
    expect(await page.locator('[data-decision-pane] [role="alert"]').count()).toBe(1);
    await page.locator("[data-switch]").click();
    expect(await page.locator('[data-decision-pane] [role="alert"]').count()).toBe(0);
  });
});
