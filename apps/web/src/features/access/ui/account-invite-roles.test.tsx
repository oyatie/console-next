// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Sheet } from "../../../ui/sheet/sheet";
import type { CreateAccessInviteBody } from "../api/access-invite";
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
const invite = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  command: vi.fn(),
}));
vi.mock("../api/access-invite", () => ({
  previewAccessInvite: invite.preview, createAccessInvite: invite.create, INVITE_WITH_ROLES_INVALIDATES: [],
}));
vi.mock("../../../lib/react/command", () => ({
  useCommand: (command: unknown) => { invite.command(command); return { mutate: vi.fn(), isPending: false, error: null }; },
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

test("recovering an uncertain invitation sends the frozen intent and key directly to create", async () => {
  renderToStaticMarkup(<InviteWithRolesSheet accountFields={<div />} displayName="Park" normalizedLogin="park"
    accountBlockedWhy={null} onTriedAccount={vi.fn()} onFocusInvalid={vi.fn()} onClose={vi.fn()} onIssued={vi.fn()} />);
  const command = invite.command.mock.lastCall![0] as {
    run: (input: CreateAccessInviteBody, key: string) => Promise<unknown>;
    verify: (input: CreateAccessInviteBody, key: string) => Promise<unknown>;
  };
  const body: CreateAccessInviteBody = { display_name: "Park", sign_in_id: "park", grants: [] };
  const key = "preserved-invite-key";
  invite.preview.mockResolvedValueOnce({ refused: 0 });
  invite.create.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ otp: null });
  await expect(command.run(body, key)).rejects.toThrow("response lost");
  await expect(command.verify(body, key)).resolves.toEqual({ otp: null });
  expect(invite.preview).toHaveBeenCalledTimes(1);
  expect(invite.create.mock.calls).toEqual([[body, key], [body, key]]);
});
