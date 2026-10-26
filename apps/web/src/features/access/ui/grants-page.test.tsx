// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog } from "@console/i18n";
import { GrantsPage } from "./grants-page";
import type { AccessGrant } from "../api";

const state = vi.hoisted(() => ({ items: [] as AccessGrant[], error: null as unknown, pending: false }));
vi.mock("@tanstack/react-query", () => ({ keepPreviousData: (data: unknown) => data, useQuery: () => ({
  data: state.pending || state.error ? undefined : { items: state.items },
  error: state.error, isPending: state.pending, refetch: () => {},
}) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({
  q: { data: true, isPending: false, error: null, refetch: () => {} },
  accounts: [], accountsQ: {}, roles: [{ id: "r", name_ko: "인사 조회" }], cat: {},
}) }));
vi.mock("./use-org-roots", () => ({ useOrgRoots: () => [] }));
vi.mock("./access-head", () => ({ AccessHead: ({ actions }: { actions: ReactNode }) => <header>{actions}</header> }));
vi.mock("./access-requests", () => ({ AccessRequests: () => null }));
vi.mock("./grant-change", () => ({ GrantChange: () => null }));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.items = []; state.error = null; state.pending = false; });
const render = (role?: string) => renderToStaticMarkup(<GrantsPage {...{ role }} />);
const row = (id: string, account: string): AccessGrant => ({
  id, account_id: account, role_id: "r", role_name_ko: "인사 조회", account_active: true, account_has_passkey: true,
  account_display_name: account, scope: { kind: "TENANT", include_descendants: true }, valid_from: "2026-10-01T00:00:00Z",
  effective_in_setup: false, enforcement: "ENFORCED", reason_code: "OTHER", granted_by: "ops", granted_at: "2026-10-01T00:00:00Z",
});

test("failed grants read has no zero count, empty claim or list filters", () => {
  state.error = new ApiError(503, "service_unavailable", "private server detail");
  const html = render();
  expect(html).toContain("불러오지 못했습니다");
  for (const text of ["부여 0건", "부여가 없습니다", "이름·사번·역할 찾기", "일 안에 끝나는 부여", "private server detail"])
    expect(html).not.toContain(text);
});

test("loading grants read makes no count or empty claim", () => {
  state.pending = true;
  const html = render();
  expect(html).not.toContain("부여 0건");
  expect(html).not.toContain("부여가 없습니다");
});

test("role title names the role and counts distinct holders, with a filter reset", () => {
  state.items = [row("g1", "a"), row("g2", "a"), row("g3", "b")];
  const html = render("r");
  expect(html).toContain("인사 조회 보유자 2명");
  expect(html).toContain("필터 초기화");
});

test("populated grants have one search and a header grant action", () => {
  state.items = [row("g1", "a")];
  const html = render();
  expect(html.match(/type="search"/g)).toHaveLength(1);
  expect(html).not.toContain("권한을 부여할 사람 (이름 또는 사번)");
  expect(html).toMatch(/<header>.*권한 부여.*<\/header>/);
});

test("empty grants name the grant action and hide filters", () => {
  const html = render();
  expect(html).toContain("「권한 부여」로 역할을 부여하십시오.");
  expect(html).not.toContain("이름·사번·역할 찾기");
});
