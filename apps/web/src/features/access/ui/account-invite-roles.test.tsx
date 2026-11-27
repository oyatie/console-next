// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Sheet } from "../../../ui/sheet/sheet";
import { InviteWithRolesSheet } from "./account-invite-roles";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (q: unknown) => {
    const key = JSON.stringify(q);
    if (key.includes("/access/roles")) {
      return {
        isSuccess: true,
        data: { items: [{ id: "r-hr", name_ko: "Staff Role", status: "ACTIVE", version: 1, holder_count: 1, lines: [] }] },
      };
    }
    if (key.includes("/access/catalog")) {
      return { data: { domains: [], levels: [], scope_kinds: [{ kind: "TENANT", enforceable: true }], reason_domain: "role_change" } };
    }
    if (key.includes("/access/me")) {
      return { data: { phase: "OPERATING" } };
    }
    return { data: { items: [], entities: [] }, isError: false };
  },
}));
vi.mock("../../../lib/react/command", () => ({
  useCommand: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: (p: Parameters<typeof Sheet>[0]) => <section>{p.consequence}{p.children}{p.actions}</section>,
}));

beforeAll(() => loadCatalog("ko"));

test("invite with roles renders role grant lines, operating start choices, and reason selector", () => {
  const html = renderToStaticMarkup(
    <InviteWithRolesSheet
      accountFields={<div data-account-fields="" />}
      displayName="Park Staff"
      normalizedLogin="park"
      accountBlockedWhy={null}
      onTriedAccount={vi.fn()}
      onFocusInvalid={vi.fn()}
      onClose={vi.fn()}
      onIssued={vi.fn()}
    />,
  );
  expect(html).toContain(t("access.grant.lines"));
  expect(html).toContain(t("accessGrants.start"));
  expect(html).toContain(t("access.grant.reason"));
});
