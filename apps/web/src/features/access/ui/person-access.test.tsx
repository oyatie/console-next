// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { PersonAccess } from "./person-access";

const state = vi.hoisted(() => ({ accounts: [] as { id: string; display_name: string; has_passkey: boolean }[] }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { entries: [], items: [], phase: "SETUP", is_ops: false }, isPending: false }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({ accounts: state.accounts, cat: {}, roles: [] }) }));
vi.mock("./use-reasons", () => ({ useReasons: () => ({ codes: [] }) }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
vi.mock("./grant-change", () => ({ GrantChange: () => null }));
beforeAll(() => loadCatalog("ko"));

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
