// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { DoneStep } from "./done-step";

beforeAll(() => loadCatalog("ko"));

test("completion actions wait for the stored result so loading metadata cannot move them", () => {
  const client = new QueryClient();
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const out = renderToStaticMarkup(<RouterContextProvider router={router}><QueryClientProvider client={client}><DoneStep runId="synthetic-run" /></QueryClientProvider></RouterContextProvider>);
  expect(out).toContain(t("common.loading"));
  expect(out).not.toContain(t("import.again"));
  expect(out).not.toContain(t("import.viewEmployees"));
  expect(out).not.toContain(t("importRollback.run.title"));
});
