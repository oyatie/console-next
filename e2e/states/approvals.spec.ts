// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { saeonAdminToken, saeonAdminUser, saeonApprovalDocument, saeonApprovalsPage, saeonUniverse } from "../mock/saeon";
import { mockScreen } from "../mock/screen";
import { faultAttempts } from "./fault-clock";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

const routes = [
  { key: "approvals", path: "/approvals", read: "/api/v1/approvals" },
  { key: "approval-viewer", path: `/approvals/${id(1)}`, read: "/api/v1/approvals/{id}" },
] as const;

for (const route of routes) {
  for (const state of ["loading", "empty", "failed", "refused"] as const) {
    for (const width of [1440, 390]) {
      test(`Console ${route.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(expKey => {
          localStorage.setItem(expKey, "console");
        }, EXPERIENCE_KEY);

        const fixture = await mockScreen(page, screens[0], state === "failed" ? "failed" : "empty");
        await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
        await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
        await mockRoute(page, "get", "/api/v1/reason-codes", { status: 200, json: { domain: "org_change_reject", items: [] } });

        let releaseRead!: () => void;
        const heldRead = new Promise<void>(resolve => {
          releaseRead = resolve;
        });
        let attempts = 0;

        await mockRoute(page, "get", "/api/v1/approvals", async () => {
          attempts++;
          if (route.key !== "approvals") {
            return { status: 200, json: saeonApprovalsPage("pending") };
          }
          if (state === "loading") await heldRead;
          if (state === "failed") return { status: 503, json: failure("service_unavailable") };
          if (state === "refused") return { status: 403, json: failure("forbidden") };
          return {
            status: 200,
            json: {
              ...saeonApprovalsPage("upcoming"),
              items: [],
              counts: { pending: 0, upcoming: 0, requested: 0, reference: 0, completed: 0 },
              sources: [],
            },
          };
        });

        await mockRoute(page, "get", "/api/v1/approvals/{id}", async () => {
          attempts++;
          if (state === "loading") await heldRead;
          if (state === "failed") return { status: 503, json: failure("service_unavailable") };
          if (state === "refused") return { status: 403, json: failure("forbidden") };
          if (state === "empty") return { status: 404, json: failure("not_found") };
          return { status: 200, json: saeonApprovalDocument(saeonUniverse.approval.documentNumber) };
        });

        try {
          await page.goto(route.path);
          const main = page.getByRole("main");

          if (state === "loading") {
            await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
            await fits(page, `${route.key}/loading/${width}`);
            await expectAxe(page, `${route.key}/loading/${width}`);
            releaseRead();
            if (route.key === "approvals") {
              await expect(main.locator('[data-pattern="worklist"]')).toBeVisible();
            } else {
              await expect(main.locator('[data-pattern="document-decision"]')).toBeVisible();
            }
          } else if (state === "failed") {
            await expect(main.getByText(t("common.loadFailed.title"), { exact: true }).first()).toBeVisible({
              timeout: 20_000,
            });
            expect(attempts).toBe(faultAttempts);
            await fits(page, `${route.key}/failed/${width}`);
            await expectAxe(page, `${route.key}/failed/${width}`);
          } else if (state === "refused") {
            await expect(main.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
            await fits(page, `${route.key}/refused/${width}`);
            await expectAxe(page, `${route.key}/refused/${width}`);
          } else if (route.key === "approvals") {
            await expect(main.getByRole("heading", { name: t("approvals.empty.pending"), exact: true })).toBeVisible();
            await fits(page, `${route.key}/empty/${width}`);
            await expectAxe(page, `${route.key}/empty/${width}`);
          } else {
            await expect(main.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toBeVisible();
            await fits(page, `${route.key}/empty/${width}`);
            await expectAxe(page, `${route.key}/empty/${width}`);
          }

          expect(fixture.unexpected).toEqual([]);
        } finally {
          releaseRead();
          fixture.release();
        }
      });
    }
  }
}
