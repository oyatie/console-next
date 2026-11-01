// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { PersonAccess } from "./person-access";

const state = vi.hoisted(() => ({ accounts: [] as { id: string; display_name: string; has_passkey: boolean }[], isOps: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { entries: [], items: [], phase: "SETUP", is_ops: state.isOps }, isPending: false }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({ accounts: state.accounts, cat: { data: { domains: [] } }, roles: [], rolesLoaded: true }) }));
vi.mock("./use-reasons", () => ({ useReasons: () => ({ codes: [] }) }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
vi.mock("./grant-change", () => ({ GrantChange: () => null }));
vi.mock("./grant-sheet", () => ({ GrantSheet: () => <div data-grant-sheet /> }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.isOps = false; });

test("an unknown account uses the generic card title without an empty name interpolation", () => {
  state.accounts = [];
  const html = renderToStaticMarkup(<PersonAccess accountId="unknown" />);
  expect(html).toContain(t("access.person.title"));
  expect(html).not.toContain(t("access.person.can", { name: "" }));
});

test("a whitespace-only account name uses the same nonempty fallback as its person label", () => {
  state.accounts = [{ id: "a", display_name: " ", has_passkey: true }];
  expect(renderToStaticMarkup(<PersonAccess accountId="a" />)).toContain(t("access.person.can", { name: t("people.label.unnamed") }));
});

test.each([false, true])("the served ops fact removes the grant action and direct-link sheet (%s)", isOps => {
  state.accounts = [{ id: "a", display_name: "운영 계정", has_passkey: true }];
  state.isOps = isOps;
  const html = renderToStaticMarkup(<PersonAccess accountId="a" grant />);
  expect(/<button[^>]*>.*?권한 부여<\/button>/.test(html)).toBe(!isOps);
  expect(html.includes("data-grant-sheet")).toBe(!isOps);
  if (isOps) expect(html).toContain(t("access.person.ops"));
});
