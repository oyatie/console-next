// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog } from "@console/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupportReference } from "./support-reference";
import { QueryState } from "./query-state";
import { Denied } from "./denied";
import { CommandError } from "./command-error";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));
beforeAll(() => loadCatalog("ko"));
const reference = "0123456789abcdef0123456789abcdef";
const at = "2026-10-22T04:50:18.769Z";
const error = (status: number) => ApiError.fromBody(new Response(null, { status }), { error: { code: "internal", message: "failed", support_ref: reference, support_ref_at: at } });
const row = (html: string) => {
  expect(html.match(/data-support-reference=/g)).toHaveLength(1);
  const ref = html.slice(html.indexOf('data-support-reference=')).split("</div>")[0];
  expect(ref).toContain(">01234567</code>");
  expect(ref).not.toContain("ref ");
  expect(ref).not.toMatch(/<span|<p|class="form"/);
  expect(ref).toContain("지원 참조 번호 복사");
  expect(ref).toContain("2026. 10. 22. 13:50 KST");
  expect(ref).not.toContain("UTC");
  expect(ref).not.toContain(".769Z</time>");
};
test("reference is compact and uses the server timestamp, not trace-id digits", () => {
  row(renderToStaticMarkup(<SupportReference reference={reference} at={at} />));
  expect(renderToStaticMarkup(<SupportReference />)).toBe("");
});
test.each([undefined, "loaded"])("QueryState renders one reference and keeps background data (%s)", data => {
  const html = renderToStaticMarkup(<QueryState q={{ isPending: false, error: error(500), data, refetch: () => {} }}>{value => <div>{value}</div>}</QueryState>);
  row(html);
  expect(html.match(/지원 참조 번호 ref/g) ?? []).toHaveLength(0);
  if (data) expect(html).toContain(data);
});
test("Denied renders the shared row inside its padded body", () => {
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Denied error={error(403)} /></QueryClientProvider>);
  row(html);
});
test("the uncertain mutation panel renders the shared reference", () => row(renderToStaticMarkup(<CommandError error={error(500)} />)));
