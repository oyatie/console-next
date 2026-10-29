// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { grantersQuery, myAccessQuery } from "../../reference/authz/api";
import { QueryState } from "./query-state";

beforeAll(() => loadCatalog("ko"));

async function markup(error: unknown, data?: string, layout?: "list" | "record" | "form" | "grid") {
  const client = new QueryClient();
  await client.fetchQuery({ ...grantersQuery, queryFn: async () => ({ count: 1, names: ["담당자"] }) });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries: [] }) });
  const submit = "submit record";
  const root = createRootRoute({ component: () => <QueryState q={{ isPending: !error && !data, error, data, refetch: () => {} }} layout={layout} back={{ to: "/org/entities", label: t("denied.entity.back") }} removed={t("denied.entity.deleted.reason")}>
    {value => <form><h1>{value}</h1><button type="submit">{submit}</button></form>}
  </QueryState> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each(["forbidden", "out_of_scope", "scope_tenant_wide_only", "access_denied"])("%s is one refusal card with code, grant contact, remedies and support ref", async code => {
  const html = await markup(new ApiError(403, code, "untranslated server message", [], "refusal-reference"), "private record");
  expect(html).toContain(code);
  expect(html).toContain("담당자");
  expect(html).toContain(t("common.denied.request"));
  expect(html).toContain("<summary");
  expect(html).toContain("이유 보기");
  expect(html).toContain("refusal-reference");
  expect(html.match(/<section /g)).toHaveLength(2);
  expect(html).toMatch(/<section class="[^"]+" aria-labelledby=/);
  expect(html).not.toContain('<span class="muted"></span>');
  expect(html).not.toContain("private record");
  expect(html).not.toContain("submit record");
  expect(html).not.toContain("untranslated server message");
  expect(html).not.toContain("내 권한 보기");
  expect(html).toContain(t("common.denied.mine.none"));
  expect(html).not.toContain('href="/account"');
  expect(html).toContain('href="/org/entities"');
  expect(html).toMatch(/class="page"/);
  expect(html.replace(/<details>[\s\S]*?<\/details>/g, "")).toContain(`<code>${code}</code>`);
});

test("a failed read uses catalog copy instead of raw server text", async () => {
  const html = await markup(new ApiError(503, "unknown_upstream_failure", "walk: simulated outage", [], "read-reference"));
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).toContain("read-reference");
  expect(html).not.toContain("walk: simulated outage");
  expect(html).toContain(t("common.read.failedReason"));
  expect(t("common.read.failedReason")).not.toContain(t("common.loadFailed.title"));
});

test("a missing record removes cached contents and offers a way back", async () => {
  const html = await markup(new ApiError(404, "not_found", "missing"), "removed record");
  expect(html).toContain(t("common.read.notFound.title"));
  expect(html).toContain('href="/org/entities"');
  expect(html).toContain(t("denied.entity.deleted.reason"));
  expect(html).not.toContain("removed record");
  expect(html).not.toContain(t("common.loadFailed.title"));
});

test.each(["list", "record", "form", "grid"] as const)("%s loading reserves the requested page geometry", async layout => {
  const html = await markup(null, undefined, layout);
  expect(html).toContain(`data-read-layout="${layout}"`);
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("submit record");
});

test("a network failure offers retry without an invented support reference", async () => {
  const html = await markup(new TypeError("Failed to fetch"));
  expect(html).not.toContain(t("common.supportReference"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain("Failed to fetch");
});

test("a server support reference keeps its copy control", async () => {
  const html = await markup(new ApiError(503, "unavailable", "busy", [], undefined, true, [], { supportRef: "support-reference" }));
  expect(html).toContain('data-support-reference="support-reference"');
  expect(html).toContain(t("common.supportReference.copy"));
});
