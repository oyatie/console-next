// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { queryDefaults } from "../../../lib/react/query-defaults";
import { settingsQuery } from "../../../reference/settings/api";
import { SettingsHubView } from "./settings-hub";

beforeAll(() => loadCatalog("ko"));

test("SettingsHubView preserves queryDefaults.retry on the shared settingsQuery cache entry", async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        ...queryDefaults,
        enabled: false,
      },
    },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <SettingsHubView rows={[]} /> }),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  await router.load();
  try {
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(client.getQueryCache().find(settingsQuery)?.options.retry).toBe(queryDefaults.retry);
  } finally {
    client.clear();
  }
});
