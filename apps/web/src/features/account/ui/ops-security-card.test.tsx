// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { OpsSecurityCard } from "./ops-security-card";

const state = vi.hoisted(() => ({
  rec: {
    eligible: true,
    holder_count: 1,
    max_holders: 2,
    contact: {
      channel: "EMAIL",
      masked_value: "o***@acme.kr",
      review_pending: true,
      updated_at: "2026-11-27T00:00:00Z",
    },
    codes: {
      total: 10,
      remaining: 9,
      generated_at: "2026-11-27T00:00:00Z",
    },
  },
  ops: {
    account_id: "u-ops-1",
    max_holders: 2,
    holders: [
      { account_id: "u-ops-1", display_name: "Kim Ops", sign_in_id: "ops1@acme.kr", has_recovery_contact: true },
    ],
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (q: unknown) => {
    const key = JSON.stringify(q);
    if (key.includes("/auth/recovery/status")) return { data: state.rec, isPending: false };
    if (key.includes("/access/ops")) return { data: state.ops, isPending: false };
    return { data: [], isPending: false };
  },
}));
vi.mock("../../../lib/react/command", () => ({
  useCommand: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

beforeAll(() => loadCatalog("ko"));

test("ops security card shows masked recovery contact, review-pending chip, remaining codes, and disables last-holder self-release", () => {
  const html = renderToStaticMarkup(<OpsSecurityCard myId="u-ops-1" />);
  expect(html).toContain("o***@acme.kr");
  expect(html).toContain(t("auth.setup.recovery.reviewPending"));
  expect(html).toContain(t("account.opsSecurity.codesRemaining", { remaining: 9, total: 10 }));
  expect(html).toContain(t("account.opsSecurity.designate"));
  expect(html).toContain(t("account.opsSecurity.releaseLastDisabled"));
});
