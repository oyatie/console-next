import type { components } from "@console/api/schema";
import { useCommand } from "../../../lib/react/command";
import { phoneE164, FORMATS } from "../../../lib/pure/formats";
import { birthDate, type Draft } from "../domain/register";
import { createEmployee, setupDeleteEmployee } from "../api";
import type { resolvePlace } from "../domain/register-place";

type Detail = components["schemas"]["EmployeeDetail"];
export type RegisterInput = { next: boolean; override?: components["schemas"]["DuplicateOverride"] };

/** Reads a registration changes: the roster, units' headcount, entities' and workplaces' counts (their end options too) and the setup checklist. */
export const REGISTER_READS = ["/api/v1/employees", "/api/v1/org-units", "/api/v1/legal-entities", "/api/v1/org-structure", "/api/v1/onboarding", "/api/v1/workplaces", "/api/v1/me/action-inbox", "/api/v1/statutory"] as const;

/**
 * One registration in one call (MR-22): the person, their company · workplace from the chosen place, and the BW-19 exception
 * when the user said a candidate is someone else. Company and site texts are display snapshots of that place.
 */
export function useRegister(d: Draft, place: ReturnType<typeof resolvePlace>, onSuccess: (out: Detail, input: RegisterInput) => void) {
  return useCommand({
    run: ({ override }: RegisterInput, key: string) => {
      return createEmployee({
            name: d.name.trim(),
            employee_number: d.numberMode === "manual" ? d.number.trim() : undefined,
            company: place?.entity || undefined,
            site: place?.site || undefined,
            org_unit_id: d.unitId || undefined,
            legal_entity_id: place?.entityId ?? undefined,
            workplace_id: place?.workplaceId ?? undefined,
            // A place without a branch is a gap the sheet names before sending (gaps "workplace").
            home_branch_id: place?.branchId ?? undefined,
            employment_type: d.type ?? undefined,
            // The server keeps E.164; an incomplete number goes as typed and comes back as a field error.
            phone: d.phone.trim() ? (phoneE164(d.phone) ?? FORMATS.phone.display(d.phone)) : undefined,
            position: d.position.trim() || undefined,
            base_pay_won: d.pay ? Number(d.pay) : undefined,
            pay_unit: d.pay ? "MONTHLY" : undefined,
            hire_date: d.hire,
            contract_end_date: d.type === "CONTRACT" ? (d.contractEnd || undefined) : undefined,
            birth_date: birthDate(d) || undefined,
            duplicate_override: override,
            idempotency_key: key,
      });
    },
    invalidates: REGISTER_READS,
    onSuccess,
  });
}

/** Undo of a registration in the setup phase (MR-26 setup delete): the record and its employee number go. */
export function useUndoRegister() {
  return useCommand({
    run: ({ id, updatedAt }: { id: string; updatedAt: string }) =>
      // a fixed internal code; the setup delete takes any code, and no reason list exists for it yet.
      setupDeleteEmployee(id, { expected_updated_at: updatedAt, reason_code: "REGISTRATION_UNDO", register_kept: false }),
    invalidates: REGISTER_READS,
  });
}
