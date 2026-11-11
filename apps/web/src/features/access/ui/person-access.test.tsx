// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- Native links make the router mock's semantics observable.
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { PersonAccess } from "./person-access";

const state = vi.hoisted(() => ({ accounts: [] as { id: string; display_name: string; has_passkey: boolean; employee_id?: string; employee_name?: string; employee_number?: string }[], isOps: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { entries: [], items: [], phase: "SETUP", is_ops: state.isOps }, isPending: false }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({ accounts: state.accounts, cat: { data: { domains: [] } }, roles: [], rolesLoaded: true }) }));
vi.mock("./use-reasons", () => ({ useReasons: () => ({ codes: [] }) }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
vi.mock("./grant-change", () => ({ GrantChange: () => null }));
vi.mock("./grant-sheet", () => ({ GrantSheet: () => <div data-grant-sheet /> }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.isOps = false; });

test("an unknown account uses the generic card title without an empty name interpolation", () => {
  state.accounts = [];
  const html = renderToStaticMarkup(<PersonAccess accountId="unknown" onGrant={() => undefined} />);
  expect(html).toContain(t("access.person.title"));
  expect(html).not.toContain(t("access.person.can", { name: "" }));
});

test("a whitespace-only account name uses the same nonempty fallback as its person label", () => {
  state.accounts = [{ id: "a", display_name: " ", has_passkey: true }];
  expect(renderToStaticMarkup(<PersonAccess accountId="a" onGrant={() => undefined} />)).toContain(t("access.person.can", { name: t("people.label.unnamed") }));
});

test("the linked person's identity is inside its record link and shown once", () => {
  state.accounts = [{ id: "a", display_name: "Account", has_passkey: true, employee_id: "employee", employee_name: "Employee", employee_number: "EMP-1" }];
  const html = renderToStaticMarkup(<PersonAccess accountId="a" onGrant={() => undefined} />);
  const link = html.match(/<a href="\/people\/\$id">([\s\S]*?)<\/a>/)?.[1] ?? "";
  expect(link.replace(/<[^>]*>/g, "")).toBe("EmployeeEMP-1");
  expect(html.replace(/<[^>]*>/g, "").match(/EMP-1/g)).toHaveLength(1);
  state.accounts[0]!.employee_id = undefined;
  const unlinked = renderToStaticMarkup(<PersonAccess accountId="a" onGrant={() => undefined} />);
  expect(unlinked).not.toContain('href="/people/$id"');
  expect(unlinked.replace(/<[^>]*>/g, "").match(/EMP-1/g)).toHaveLength(1);
});

test.each([false, true])("the served ops fact removes the grant action and direct-link sheet (%s)", isOps => {
  state.accounts = [{ id: "a", display_name: "운영 계정", has_passkey: true }];
  state.isOps = isOps;
  const html = renderToStaticMarkup(<PersonAccess accountId="a" grant onGrant={() => undefined} />);
  expect(/<button[^>]*>.*?권한 부여<\/button>/.test(html)).toBe(!isOps);
  expect(html.includes("data-grant-sheet")).toBe(!isOps);
  if (isOps) expect(html).toContain(t("access.person.ops"));
});
