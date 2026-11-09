// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { approvalPages, approvalDocumentQuery } from "./api";

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

test.each(["ko", "en"] as const)("canonical document codes use the %s catalog", async locale => {
  await loadCatalog(locale);
  const document = { id: "org_change:request", box: "requested", status: { key: "IN_APPROVAL" }, route: [{ id: "step", role_key: "hr", state: "current" }], body: [], revision: 1, fingerprint: "source-version", consequence: "", opinion_max: 0, my_actions: { kind: "none" } };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }));
  const result = await approvalDocumentQuery(document.id).queryFn();
  expect(result.status).toEqual({ key: "IN_APPROVAL", label: t("enum.orgChangeStatus.IN_APPROVAL"), tone: "info" });
  expect(result.route[0]?.label).toBe(t("enum.approvalRole.hr"));
  expect(result.body).toEqual([]);
  expect(result.fingerprint).toBe("source-version");
});
