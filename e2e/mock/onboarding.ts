// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { GoLivePreview } from "@console/api/pending";
import { failure, id, screenAccess, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";
import type { OnboardingScreen, OnboardingState } from "../states/onboarding";

export function previewData(state: "blocked" | "ready" | "receipt" | "legacy-receipt" | "missing-receipt" | "unknown-receipt" | "loading" | "failed" | "refused"): GoLivePreview {
  const isReceipt = state.endsWith("receipt");
  const records = state === "blocked"
    ? Array.from({ length: 2000 }, (_, i) => ({ kind: "employee", id: id(1000 + i), name: `부서지정대상 ${String(i + 1).padStart(4, "0")}`, legal_entity_id: id(10) }))
    : [];
  const breakdown = Array.from({ length: 20 }, (_, i) => ({
    kind: i === 0 ? "legal_entity" as const : "workplace" as const,
    id: id(50 + i), legal_entity_id: id(10), name: i === 0 ? "검증법인" : `검증사업장 ${i}`, people: 100, units: 3,
  }));
  return {
    phase: isReceipt ? "OPERATING" : "SETUP", digest: `digest-${state}`, line_digests: {}, terms_version: null,
    blockers: isReceipt ? [{ code: "already_operating", count: null, remedy: null, records: [] }] : state === "blocked" ? [{ code: "people_without_department", count: records.length, remedy: "assign_department", records }] : [],
    warnings: isReceipt ? [] : [{ code: "sole_holder", count: 1, remedy: null, records: [] }],
    becomes_governed: ["setup_undo_becomes_correction", "entity_identifier_corrections_locked", "org_structure_changes_need_approval"],
    breakdown,
    roles_becoming_active: [{ role_id: id(80), role: "인사 담당", scope_kind: "TENANT", scope_id: id(2), scope: "전체", holders: [{ id: id(1), name: "김담당" }] }],
    access_admin_holders: [{ id: id(1), name: "김담당" }],
    hr_accounts_with_no_grant: [],
    facts: {
      phase_is_setup: !isReceipt, terms_accepted: true, org_step_skipped: false,
      security_contact_recorded: true, security_contact_store_available: true, employees_step_deferred: false,
      entities_needing_confirmation: 0, registrations: 1, registrations_needing_confirmation: 0,
      registrations_unverified: 0, entities_without_primary_workplace: 0, workplaces_incomplete: 0,
      org_change_approvers: 1, other_eligible_holders: 0, org_change_routed: true,
      unmapped_assignments: 0, insurance_not_established_with_people: 0, insurance_numbers_pending: 0,
      org_changes_in_approval: 0, own_passkeys: 2, unplaced_people: 0, entity_unknown_people: 0,
      tenant_roles: 1, non_ops_grants: 0, access_admin_holders: 1, roles_step_skipped: false,
      entities: 1, workplaces: 19, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0,
      org_units: 60, employees: 2000, employees_starting_later: 0, setup_writes: 12,
      prepared_grants: 1, grants_effective_in_setup: 0, hr_accounts_invited: 1, hr_accounts_enrolled: 1,
    },
  };
}

export function emptyPreview(): GoLivePreview {
  const preview = previewData("ready");
  return { ...preview, blockers: [
    { code: "terms_not_accepted", count: null, remedy: "accept_terms", records: [] },
    { code: "no_legal_entity", count: null, remedy: "create_legal_entity", records: [] },
    { code: "no_workplace", count: null, remedy: "create_workplace", records: [] },
    { code: "security_contact_missing", count: null, remedy: "record_security_contact", records: [] },
  ],
    warnings: [], breakdown: [], roles_becoming_active: [], access_admin_holders: [],
    facts: {
      phase_is_setup: true, terms_accepted: false, org_step_skipped: false,
      security_contact_recorded: false, security_contact_store_available: true, employees_step_deferred: false,
      entities_needing_confirmation: 0, registrations: 0, registrations_needing_confirmation: 0,
      registrations_unverified: 0, entities_without_primary_workplace: 0, workplaces_incomplete: 0,
      org_change_approvers: 0, other_eligible_holders: 0, org_change_routed: false,
      unmapped_assignments: 0, insurance_not_established_with_people: 0, insurance_numbers_pending: 0,
      org_changes_in_approval: 0, own_passkeys: 0, unplaced_people: 0, entity_unknown_people: 0,
      tenant_roles: 0, non_ops_grants: 0, access_admin_holders: 0, roles_step_skipped: false,
      entities: 0, workplaces: 0, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0,
      org_units: 0, employees: 0, employees_starting_later: 0, setup_writes: 0,
      prepared_grants: 0, grants_effective_in_setup: 0, hr_accounts_invited: 0, hr_accounts_enrolled: 0,
    },
  };
}

export async function mockOnboarding(page: Page, screen: OnboardingScreen, state: OnboardingState) {
  const shell = await mockScreen(page, screens.find(s => s.key === "org")!, "empty");
  await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [], next_offset: null } });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: {
    ...user, is_tenant_ops: true, tenant: { name: "화면 검증 회사", phase: "SETUP", go_live_at: null },
  } });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess(screen.path, "SETUP"), is_ops: true } });
  const held = Promise.withResolvers<void>();
  let recovered = false;
  let attempts = 0;
  const beforeReply = async () => {
    attempts++;
    if (state === "loading" && !recovered) await held.promise;
    if (state === "failed" && !recovered) return { status: 503 as const, json: failure("service_unavailable") };
    if (state === "refused" && !recovered) return { status: 403 as const, json: failure("forbidden") };
    return null;
  };
  if (screen.key === "setup-go-live") {
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", async () => await beforeReply() ?? { status: 200, json: emptyPreview() });
  } else if (screen.key === "setup-company-names") {
    await mockRoute(page, "get", "/api/v1/legal-entities", async () => await beforeReply() ?? { status: 200, json: { items: [] } });
  } else {
    await mockRoute(page, "get", "/api/v1/org-structure", async () => await beforeReply() ?? { status: 200, json: { tenant_name: "화면 검증 회사", phase: "SETUP" as const, entities: [], unplaced: [] } });
  }
  return { ...shell, attempts: () => attempts, recover: () => { recovered = true; held.resolve(); },
    release: () => { held.resolve(); shell.release(); },
  };
}
