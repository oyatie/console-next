// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { readEntity } from "../api";
import { loadCatalog, t } from "@console/i18n";
import { EntityError } from "./entity-error";

const get = vi.hoisted(() => vi.fn());
vi.mock("@console/api", async (original) => ({
  ...(await original<typeof import("@console/api")>()),
  api: { GET: get },
}));
beforeAll(() => loadCatalog("ko"));

test("entity validation explains the field in Korean and encloses its reference inside the summary", async () => {
  get.mockResolvedValueOnce({
    response: new Response(null, { status: 422 }),
    error: { error: {
      code: "validation_failed", message: "validation failed", operation_id: "entity-refusal",
      errors: [{ field: "english_name", code: "english_name_not_latin" }],
    } },
  });
  const error: unknown = await readEntity("entity").catch((refusal: unknown) => refusal);
  const root = createRootRoute({ component: () => createElement(EntityError, { error }) });
  const outcome = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const router = createRouter({ routeTree: root.addChildren([outcome]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const markup = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(markup).toContain(renderToStaticMarkup(createElement(Fragment, null, t("entity.refusal.english_name_not_latin"))));
  expect(markup).not.toContain("english_name_not_latin");
  expect(markup).toContain(t("common.operationId"));
  expect(markup).toContain('href="/requests/entity-refusal"');
  expect(markup).toMatch(/data-component="error-summary"[^]*href="\/requests\/entity-refusal"[^]*entity-refusal<\/span><\/div><\/div><\/div>$/);
});
