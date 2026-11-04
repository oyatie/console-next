// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { approvalPages } from "./api";

beforeAll(() => configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } }));
afterEach(() => vi.unstubAllGlobals());

test.each(["ko", "en"] as const)("approval status and route codes use the %s catalog for items and focus", async locale => {
  await loadCatalog(locale);
  const document = { id: "org_change:request", box: "pending", status: { key: "IN_APPROVAL" }, route: [{ id: "step", role_key: "hr", state: "current" }] };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [document], focused: document, sources: [], counts: {}, next_cursor: null }), { headers: { "content-type": "application/json" } }));
  const result = await approvalPages({ box: "pending" }).queryFn({ pageParam: undefined });
  expect(result.items[0]?.status).toEqual({ key: "IN_APPROVAL", label: t("enum.orgChangeStatus.IN_APPROVAL"), tone: "info" });
  expect(result.items[0]?.route[0]?.label).toBe(t("enum.approvalRole.hr"));
  expect(result.focused).toEqual(result.items[0]);
});
