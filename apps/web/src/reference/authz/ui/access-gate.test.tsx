// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { Button } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import { loadCatalog, t } from "@console/i18n";
import { ApiError, myAccessQuery, type AccessEffective } from "../api";
import { accessRefusal, type AccessRequirement } from "../domain/access";
import { AccessGate, PageReadGate, RouteGuard } from "./access-gate";
import { entityReadAccess } from "../domain/feature-access";

let routeAccess: AccessRequirement | "signed-in" | undefined;
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) => select([
    { staticData: {} }, { staticData: { access: "signed-in" } }, { staticData: { access: routeAccess } },
  ]),
}));

const access = (enforcement: string, kind: "TENANT" | "WORKPLACE" = "TENANT") => ({
  is_ops: false, entries: [{ grant_id: "grant", role_name_ko: "held", domain: "org", level: "edit", enforcement, scope: { kind } }],
}) as AccessEffective;
beforeAll(() => loadCatalog("ko"));

test.each(["missing", "scoped", "allowed"])("all required reads decide before the page mounts: %s", async state => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  routeAccess = { allOf: [{ domain: "hr_basic", level: "edit" }, entityReadAccess] };
  const entries = [{ ...access("ENFORCED").entries[0]!, domain: "hr_basic" },
    ...(state === "missing" ? [] : [{ ...access("ENFORCED").entries[0]!, scope: { kind: state === "scoped" ? "DEPARTMENT" : "WORKPLACE" } }])];
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries }) as AccessEffective });
  const child = vi.fn(() => "page with required lookups");
  function Page() { return child(); }
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouteGuard><Page /></RouteGuard></QueryClientProvider>);
    if (state === "allowed") expect(child).toHaveBeenCalledOnce();
    else {
      expect(child).not.toHaveBeenCalled();
      expect(html).toContain(state === "missing" ? "access_denied" : "out_of_scope");
      expect(html).toContain("인사기본 · 등록·수정 / 조직 · 조회");
    }
  } finally { client.clear(); }
});

test("an empty all-of contract fails closed", () => {
  expect(accessRefusal(access("ENFORCED"), { allOf: [] })).toBe("access_denied");
});

test("missing route metadata never mounts the page", () => {
  routeAccess = undefined;
  const child = vi.fn();
  function Page() { child(); return null; }
  expect(() => renderToStaticMarkup(<RouteGuard><Page /></RouteGuard>)).toThrow("Route must declare staticData.access");
  expect(child).not.toHaveBeenCalled();
});

test.each(["edit", "approve", "export"] as const)("%s implies view for an edit-only or normalized server response", level => {
  const entry = { ...access("ENFORCED").entries[0]!, domain: "hr_basic", level } as AccessEffective["entries"][number];
  for (const entries of [[entry], [entry, { ...entry, level: "view" as const }]]) {
    expect(accessRefusal({ is_ops: false, entries } as AccessEffective, { domain: "hr_basic", level: "view" })).toBeNull();
  }
  expect(accessRefusal({ is_ops: false, entries: [{ ...entry, enforcement: "REVOKED" }] } as AccessEffective, { domain: "hr_basic", level: "view" })).toBe("access_denied");
});

test("an explicit Cedar refusal on the implied row is never widened", () => {
  const edit = access("ENFORCED").entries[0]!;
  const entries = [edit, { ...edit, level: "view" as const, enforcement: "SCOPE_UNAVAILABLE" as const }];
  expect(accessRefusal({ is_ops: false, entries } as AccessEffective, { domain: "org", level: "view" })).toBe("access_denied");
});

test.each(["TENANT", "LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT"])("entity read reach %s decides before the page mounts", async kind => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  routeAccess = entityReadAccess;
  const entry = { ...access("ENFORCED").entries[0]!, level: "view", scope: { kind } };
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries: [entry] }) as AccessEffective });
  const child = vi.fn(() => "structure page");
  function Page() { return child(); }
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouteGuard><Page /></RouteGuard></QueryClientProvider>);
    if (kind === "DEPARTMENT") {
      expect(child).not.toHaveBeenCalled();
      expect(html).toContain("out_of_scope");
      expect(html).toContain("조직 · 조회");
    } else expect(child).toHaveBeenCalledOnce();
  } finally { client.clear(); }
});

test.each([false, true])("a department HR grant: tenant requirement %s", tenant => {
  const entry = { ...access("ENFORCED").entries[0]!, domain: "hr_basic", scope: { kind: "DEPARTMENT" } };
  const held = { is_ops: false, entries: [entry] } as AccessEffective;
  expect(accessRefusal(held, { domain: "hr_basic", level: "view", tenant })).toBe(tenant ? "scope_tenant_wide_only" : null);
});

test.each(["refused", "loading", "allowed", "signed-in"])("route guard %s decides before any page child mounts", async state => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  routeAccess = state === "signed-in" ? "signed-in" : { domain: "org", level: "view" };
  if (state !== "loading") await client.fetchQuery({ ...myAccessQuery, queryFn: async () => access(state === "allowed" ? "ENFORCED" : "REVOKED") });
  const privatePage = "private page";
  const child = vi.fn(() => <Button>{privatePage}</Button>);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouteGuard><RouteChild /></RouteGuard></QueryClientProvider>);
  function RouteChild() { return child(); }
  if (state === "allowed" || state === "signed-in") expect(child).toHaveBeenCalledOnce();
  else {
    expect(child).not.toHaveBeenCalled();
    expect(html).not.toContain(privatePage);
    if (state === "refused") {
      expect(html.match(/aria-label="이 화면에 접근 권한이 없습니다"/g)).toHaveLength(1);
      expect(html).toContain("조직 · 조회");
    } else expect(html).toContain('data-read-layout="list"');
  }
  client.clear();
});

test.each(["PREPARED", "SCHEDULED", "ENDED", "REVOKED", "ROLE_INACTIVE", "SCOPE_UNAVAILABLE", "ACCOUNT_INACTIVE"])("%s cannot mount a form", enforcement => {
  expect(accessRefusal(access(enforcement), { domain: "org", level: "edit" })).toBe("access_denied");
});

test("a tenant-wide form refuses a scoped grant without widening it", () => {
  const scoped = access("ENFORCED", "WORKPLACE");
  expect(accessRefusal(scoped, { domain: "org", level: "edit", tenant: true })).toBe("scope_tenant_wide_only");
  expect(accessRefusal(scoped, { domain: "org", level: "edit" })).toBeNull();
  expect(accessRefusal(access("ENFORCED"), { domain: "org", level: "edit", tenant: true })).toBeNull();
});

test("the ops verdict comes from the server, not a role-name assumption", () => {
  expect(accessRefusal({ is_ops: true, entries: [] } as unknown as AccessEffective, { domain: "org", level: "edit", tenant: true })).toBeNull();
  expect(accessRefusal(access("ENFORCED"), { domain: "access", level: "edit" })).toBe("access_denied");
});

test("an ungranted route renders only its refusal and never mounts the editor", async () => {
  const client = new QueryClient();
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => access("REVOKED") });
  function Editor(): never { throw new Error("private editor mounted"); }
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><AccessGate domain="org" level="edit"><Editor /></AccessGate></QueryClientProvider>);
  expect(html).toContain("access_denied");
  expect(html).not.toContain("private editor");
});

test.each([403, 503])("a cached missing grant still refuses the form after a %i refetch", async status => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => access("REVOKED") });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => {
    throw new ApiError(status, "out_of_scope", "", [], "grant-reference");
  } }).catch(() => undefined);
  const content = "private editor";
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><AccessGate domain="org" level="edit"><span>{content}</span></AccessGate></QueryClientProvider>);
  expect(html).toContain("이 화면에 접근 권한이 없습니다");
  expect(html).not.toContain(content);
  if (status === 403) {
    expect(html).toContain("out_of_scope");
    expect(html).toContain("grant-reference");
  }
});

// Refusal replaces every page control, including controls placed above a nested data region.
test.each([403, 404])("page refusal %s withholds cached body and header controls", status => {
  const q = { isPending: false, data: { private: true }, error: new ApiError(status, "forbidden", ""), refetch: () => {} };
  function Body(): never { throw new Error("refused body mounted"); }
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PageReadGate q={q}>
    <header><TextInput aria-label={t("tenants.search")} /><Button>{t("tenants.create")}</Button></header><Body />
  </PageReadGate></QueryClientProvider>);
  expect(html).not.toContain(t("tenants.search"));
  expect(html).not.toContain(t("tenants.create"));
  expect(html).toContain(status === 403 ? "이 화면에 접근 권한이 없습니다" : "기록을 찾을 수 없습니다");
  client.clear();
});
