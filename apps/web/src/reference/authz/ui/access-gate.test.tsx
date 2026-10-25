// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { Button } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import { loadCatalog, t } from "@console/i18n";
import { ApiError, myAccessQuery, type AccessEffective } from "../api";
import { accessRefusal } from "../domain/access";
import { AccessGate, PageReadGate } from "./access-gate";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));

const access = (enforcement: string, kind: "TENANT" | "WORKPLACE" = "TENANT") => ({
  is_ops: false, entries: [{ domain: "org", level: "edit", enforcement, scope: { kind } }],
}) as AccessEffective;
beforeAll(() => loadCatalog("ko"));

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
