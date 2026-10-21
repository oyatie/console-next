// the grants list's find and filters (mockup M7, governance-23): a find box over name · employee number · role, one role, and the grants
// that end within the window. The list is the tenant's live grants (the pilot: ops and HR workers), filtered here.
import { addDays } from "../../../ui/date/days";
import { lastDay } from "./grants";

export type GrantRow = {
  account_display_name?: string | null;
  account_employee_number?: string | null;
  role_id: string;
  role_name_ko: string;
  valid_to?: string | null;
};
export type GrantFilter = { q: string; role: string | null; ending: boolean };

/** The window "ending within n days" reads (the mockup's 30 days; a view filter, not a policy). */
export const ENDING_DAYS = 30;

/** Whether a grant's last day falls within `days` from `today` (an open end never does). */
export const endsWithin = (g: Pick<GrantRow, "valid_to">, today: string, days = ENDING_DAYS) => {
  const last = lastDay(g.valid_to);
  return last != null && last <= addDays(today, days);
};

export function filterGrants<G extends GrantRow>(grants: readonly G[], f: GrantFilter, today: string): G[] {
  const term = f.q.trim().toLowerCase();
  return grants.filter(
    (g) =>
      (!f.role || g.role_id === f.role) &&
      (!f.ending || endsWithin(g, today)) &&
      (!term || [g.account_display_name, g.account_employee_number, g.role_name_ko].some((v) => (v ?? "").toLowerCase().includes(term))),
  );
}
