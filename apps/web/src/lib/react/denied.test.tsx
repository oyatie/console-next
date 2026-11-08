// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Denied } from "./denied";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));
beforeAll(() => loadCatalog("ko"));

test.each(["forbidden", "out_of_scope", "scope_tenant_wide_only"])("%s keeps its diagnostic inside the reason disclosure and its support reference visible", code => {
  const error = new ApiError(403, code, "internal basis", [], "operation", true, [], { supportRef: "support-reference" });
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Denied error={error} /></QueryClientProvider>);
  expect(markup).not.toContain("내 권한 보기");
  const visible = markup.replace(/<details>[\s\S]*?<\/details>/g, "");
  expect(visible).not.toContain(`<code translate="no">${code}</code>`);
  const details = markup.match(/<details>[\s\S]*?<\/details>/)?.[0];
  expect(details).toContain(`<code translate="no">${code}</code>`);
  expect(details).toContain(t(code === "out_of_scope" ? "common.denied.scope" : code === "scope_tenant_wide_only" ? "common.denied.tenantWide" : "common.denied.reason"));
  expect(visible).toContain('data-support-reference="support-reference"');
  expect(markup).not.toMatch(/<span[^>]*><\/span>|<p><\/p>/);
  expect(markup).not.toContain("internal basis");
});

test("a local route refusal never invents a server error code", () => {
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Denied /></QueryClientProvider>);
  expect(markup).not.toContain("access_denied");
  expect(markup).not.toContain("<code>");
});

test.each([new ApiError(403, "forbidden", "internal basis"), new TypeError("Failed to fetch")])("a refusal without a server reference leaves no empty wrapper: %s", error => {
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Denied error={error} /></QueryClientProvider>);
  expect(markup).not.toContain('<div class="muted"></div>');
  expect(markup).not.toContain("data-support-reference");
});
