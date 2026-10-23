// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import type { AccessGrant, Account } from "../api";
import { GrantSheet } from "./grant-sheet";

const state = vi.hoisted(() => ({ saved: undefined as ((out: { items: AccessGrant[]; operation_id: string }) => void) | undefined }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { entities: [] } }) }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (opts: { invalidates?: unknown; onSuccess: typeof state.saved }) => {
  if (opts.invalidates) state.saved = opts.onSuccess;
  return { isPending: false, error: null };
} }));
vi.mock("../domain/grants", async (original) => ({ ...await original<typeof import("../domain/grants")>(),
  blankLine: (key: string) => ({ key, role_id: "r", scope: { kind: "TENANT", include_descendants: true }, end: "2099-12-31" }),
}));
vi.mock("./use-reasons", () => ({ useReasons: () => ({ codes: [] }) }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: ({ consequence }: { consequence: ReactNode }) => <>{consequence}</> }));
beforeAll(() => loadCatalog("ko"));

test.each(["", "   "])("a grant for blank name %j uses the shared fallback in its consequence and receipt", (display_name) => {
  const account = { id: "a", display_name, has_passkey: true } as Account;
  const onGranted = vi.fn();
  for (const setup of [true, false]) {
    const html = renderToStaticMarkup(<GrantSheet account={account} me="actor" ops="ops" cat={{ domains: [], levels: [], scope_kinds: [], reason_domain: "role_change" }} roles={[]} setup={setup} onClose={() => {}} onGranted={onGranted} />);
    expect(html).toContain(t("people.label.unnamed"));
    expect(html).not.toMatch(/>\s*님/);
    state.saved!({ items: [{ id: "g", account_id: account.id, enforcement: setup ? "PREPARED" : "ENFORCED" } as AccessGrant], operation_id: "operation" });
    const message = onGranted.mock.lastCall![0];
    expect(message).toBe(t("access.grant.done", { name: t("people.label.unnamed"), count: 1 }));
    expect(message).not.toMatch(/^\s*님/);
  }
});
