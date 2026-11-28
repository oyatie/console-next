// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { accessRefusal, accountLabel, reviewScopeText } from "./present";

beforeAll(() => loadCatalog("ko"));

test("same-name accounts without employee records have different masked sign-in labels", () => {
  const a = { id: "a", display_name: "Namesake", employee_number: null, sign_in_id: "worker1234@example.test" };
  const b = { ...a, id: "b", sign_in_id: "worker5678@example.test" };
  expect(accountLabel(a, a.id)).toBe("Namesake · w••••1234@example.test");
  expect(accountLabel(b, b.id)).toBe("Namesake · w••••5678@example.test");
});

test("missing employee number uses primary placement, and missing all facts uses a labelled placeholder", () => {
  expect(accountLabel({ id: "a", display_name: "Person", employee_number: " ", employee_company: "Company", employee_org_unit: "HR" }, "a")).toBe("Person · Company · HR");
  expect(accountLabel({ id: "account-id", display_name: "Person", employee_number: null }, "account-id")).toBe("Person · 식별 정보 없음");
  expect(accountLabel(undefined, "account-id")).toBe(`${t("people.label.unnamed")} · 식별 정보 없음`);
});

test("an empty name never leaves an empty interpolation", () => {
  expect(accountLabel({ id: "a", display_name: "  ", employee_number: "E-1" }, "a")).toBe(`${t("people.label.unnamed")} · E-1`);
});

test("all five access refusal codes resolve in both ko and en catalogs", async () => {
  const codes = [
    "role_not_draft",
    "role_has_active_grants",
    "access_request_note_required",
    "access_request_closed",
    "access_request_not_found",
  ] as const;
  for (const locale of ["ko", "en"] as const) {
    await loadCatalog(locale);
    for (const code of codes) {
      const msg = accessRefusal(code);
      expect(msg).toBeTruthy();
      expect(msg).not.toContain(code);
    }
  }
  await loadCatalog("ko");
});

test("same-name frozen workplace scopes retain distinct target identities and descendant reach", () => {
  const site = { scope_kind: "WORKPLACE", scope_label: "Shared site", scope_node_id: "site-a", scope_include_descendants: true };
  expect(reviewScopeText(site)).toBe(t("access.scope.below.short", { name: "Shared site (site-a)" }));
  expect(reviewScopeText({ ...site, scope_node_id: "site-b", scope_include_descendants: false })).toBe(t("access.scope.only.short", { name: "Shared site (site-b)" }));
  expect(reviewScopeText({ scope_kind: "WORKPLACE", scope_label: "WORKPLACE" })).toBe("WORKPLACE");
});
