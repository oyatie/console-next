// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { DoneStep } from "./done-step";
import { JobStep } from "./job-step";
import { applyJobQuery } from "../api";

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

test("a failed atomic apply promises no saved rows and drops the running heading", async () => {
  const client = new QueryClient();
  await client.prefetchQuery({ ...applyJobQuery("synthetic-run"), queryFn: async () => ({
    run_id: "synthetic-run", state: "failed", total: 2, done: 0,
    dry_run_digest: "synthetic-digest", requested_by: "synthetic-viewer",
  }) });
  const out = renderToStaticMarkup(<QueryClientProvider client={client}><JobStep runId="synthetic-run" onDone={() => {}} onFailed={() => {}} /></QueryClientProvider>);
  expect(out).toContain("아무 행도 저장하지 않았습니다");
  expect(out).not.toContain("이미 들어간");
  expect(out).not.toContain(t("importJob.title"));
  expect(out).toContain(t("importJob.back"));
});

test("an atomic apply timeout offers review and retry without splitting the file", () => {
  const out = t("import.timedOut", { rows: 300 });
  expect(out).toContain("아무 행도 저장하지 않았습니다");
  expect(out).not.toContain("이미 들어간");
  expect(out).not.toContain("나누어");
});
