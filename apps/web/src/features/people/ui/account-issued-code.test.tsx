// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Dialog } from "../../../ui/dialog";
import { IssuedCode } from "./account-issued-code";

vi.mock("@tanstack/react-router", () => ({
  Link: (p: { children?: unknown; className?: string }) => <span className={p.className}>{p.children as never}</span>,
}));
vi.mock("../../../ui/dialog", () => ({
  Dialog: (p: Parameters<typeof Dialog>[0]) => (p.open ? <section data-title={p.title}>{p.children}</section> : null),
}));

beforeAll(() => loadCatalog("ko"));

test("peer ops reset receipt omits cleartext OTP, copy buttons, and invite link", () => {
  const html = renderToStaticMarkup(
    <IssuedCode
      issued={{
        userId: "u-ops-2",
        user_id: "u-ops-2",
        name: "Kim Ops",
        reset: true,
        signInId: "ops2@acme.kr",
        otp: "",
        expires_at: "2026-11-28T03:00:00Z",
        delivered_to_recovery_contact: true,
        masked_contact: "o***@acme.kr",
      }}
      onDone={vi.fn()}
    />,
  );
  expect(html).toContain(t("accounts.reset.peerDelivered", { name: "Kim Ops", masked: "o***@acme.kr" }));
  expect(html).not.toContain('class="secret"');
  expect(html).not.toContain(t("common.copyCode"));
  expect(html).not.toContain(t("common.copyInviteLink"));
});

test("combined invite with initial role grants renders grant count and links to person access view", () => {
  const html = renderToStaticMarkup(
    <IssuedCode
      issued={{
        userId: "u-new",
        user_id: "u-new",
        name: "Park Staff",
        signInId: "park@acme.kr",
        otp: "ABCD2-EFGH3",
        expires_at: "2026-11-28T03:00:00Z",
        grantedCount: 2,
      }}
      onDone={vi.fn()}
    />,
  );
  expect(html).toContain("ABCD2-EFGH3");
  expect(html).toContain(t("accounts.issued.granted", { count: 2 }));
  expect(html).toContain(t("accounts.access.view"));
  expect(html).not.toContain(t("accounts.issued.grant"));
});
