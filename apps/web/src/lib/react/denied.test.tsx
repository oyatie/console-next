// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog } from "@console/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Denied } from "./denied";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));
beforeAll(() => loadCatalog("ko"));

test("refusal metadata stays visible, without a duplicate access link or empty reason", () => {
  const error = new ApiError(403, "out_of_scope", "internal basis", [], "operation", true, [], { supportRef: "support-reference" });
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Denied error={error} /></QueryClientProvider>);
  expect(markup).not.toContain("내 권한 보기");
  const visible = markup.replace(/<details>[\s\S]*?<\/details>/g, "");
  expect(visible).toContain("<code>out_of_scope</code>");
  expect(visible).toContain('data-support-reference="support-reference"');
  expect(markup).not.toMatch(/<span[^>]*><\/span>|<p><\/p>/);
  expect(markup).not.toContain("internal basis");
});

test("a local route refusal never invents a server error code", () => {
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Denied /></QueryClientProvider>);
  expect(markup).not.toContain("access_denied");
  expect(markup).not.toContain("<code>");
});
