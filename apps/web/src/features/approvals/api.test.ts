// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { configure } from "@console/api";
import { fmtDate } from "@console/i18n/format";
import { loadCatalog, t } from "@console/i18n";
import { approvalPages, approvalDocumentQuery } from "./api";

beforeAll(() => configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } }));
afterEach(() => vi.unstubAllGlobals());

test.each(["ko", "en"] as const)("approval status and route codes use the %s catalog for items, focus and facets", async locale => {
  await loadCatalog(locale);
  const document = { id: "org_change:request", box: "pending", source: { key: "org_change", label: "조직 변경" }, facts: [], effective_date: "2026-12-01", status: { key: "IN_APPROVAL" }, route: [{ id: "step", role_key: "hr", state: "current" }] };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [document], focused: document, sources: [{ key: "org_change", label: "조직 변경", count: 1 }], counts: {}, next_cursor: null }), { headers: { "content-type": "application/json" } }));
  const result = await approvalPages({ box: "pending" }).queryFn({ pageParam: undefined });
  expect(result.items[0]?.status).toEqual({ key: "IN_APPROVAL", label: t("enum.orgChangeStatus.IN_APPROVAL"), tone: "info" });
  expect(result.items[0]?.route[0]?.label).toBe(t("enum.approvalRole.hr"));
  expect(result.focused).toEqual(result.items[0]);
  expect(result.items[0]?.facts).toEqual([{ key: "effective_date", label: t("approvals.field.effectiveDate"), value: fmtDate(document.effective_date) }]);
  expect(result.sources).toEqual([{ key: "org_change", label: t("approvals.source.orgChange"), count: 1 }]);
});

test.each(["ko", "en"] as const)("canonical document codes use the %s catalog", async locale => {
  await loadCatalog(locale);
  const document = { id: "org_change:request", box: "requested", source: { key: "org_change", label: "조직 변경" }, facts: [], status: { key: "IN_APPROVAL" }, route: [{ id: "step", role_key: "hr", state: "current" }], body: [], proposal_names: { workplace: "본점" }, revision: 1, fingerprint: "source-version", consequence: "", opinion_max: 0, my_actions: { kind: "none" } };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }));
  const result = await approvalDocumentQuery(document.id).queryFn();
  expect(result.status).toEqual({ key: "IN_APPROVAL", label: t("enum.orgChangeStatus.IN_APPROVAL"), tone: "info" });
  expect(result.route[0]?.label).toBe(t("enum.approvalRole.hr"));
  expect(result.body).toEqual([]);
  expect(result.fingerprint).toBe("source-version");
});


test.each(["ko", "en"] as const)("source proposal and business date are presented through the %s catalog", async locale => {
  await loadCatalog(locale);
  const document = { id: "org_change:request", box: "requested", source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" }, route: [],
    facts: [], effective_date: "2026-12-01", body: [],
    proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: "workplace", name: "고객지원부" }],
    proposal_names: { workplace: "본점" }, revision: 1, fingerprint: "source-version", consequence: "", opinion_max: 0, my_actions: { kind: "none" } };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }));
  const result = await approvalDocumentQuery(document.id).queryFn();
  expect(result.source.label).toBe(t("approvals.source.orgChange"));
  expect(result.facts).toEqual([{ key: "effective_date", label: t("approvals.field.effectiveDate"), value: fmtDate(document.effective_date) }]);
  expect(result.body).toHaveLength(1);
  expect(result.body[0]?.label).toBe(t("approvals.field.proposal"));
  expect(result.body[0]?.value).toContain("고객지원부");
  expect(result.body[0]?.value).toContain("본점");
  expect(result.body[0]?.value).not.toContain("workplac");
  expect(result.body[0]?.value).not.toContain("CREATE_ORG_UNIT");
});
