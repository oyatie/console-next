// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { DocumentPane } from "./document-pane";

beforeAll(() => loadCatalog("ko"));
afterEach(() => vi.restoreAllMocks());

test.each(["application/pdf", "image/png"])("preview refuses an active URL for %s", (type) => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("javascript:alert(1)");
  const markup = html(<QueryClientProvider client={new QueryClient()}>
    <DocumentPane doc={null} manual initial={[new File(["fixture"], "certificate", { type })]} onUploaded={() => undefined} />
  </QueryClientProvider>);
  expect(markup).not.toMatch(/<(?:object|img)\b/);
});

test.each(["application/pdf", "image/png"])("preview keeps a local blob URL for %s", (type) => {
  const url = "blob:https://example.com/certificate";
  vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
  const markup = html(<QueryClientProvider client={new QueryClient()}>
    <DocumentPane doc={null} manual initial={[new File(["fixture"], "certificate", { type })]} onUploaded={() => undefined} />
  </QueryClientProvider>);
  expect(markup).toContain(`${type === "application/pdf" ? "data" : "src"}="${url}"`);
});
