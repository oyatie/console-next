import type { components } from "@console/api/schema";

// Accounts: the view's URL state and how an unkeyed account command's outcome is settled. There are no preset roles
// (decision #19, governance-01): an account carries no access; access comes from tenant roles granted under Access.

/** The accounts view's URL state beside the roster's: the inactive toggle, the open sheet, a person to invite. */
export type AccountsSearch = { inactive?: true; act?: string; employee?: string };
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
export const accountsSearch = (s: Record<string, unknown>): AccountsSearch => ({
  inactive: s.inactive === true || s.inactive === "1" || s.inactive === 1 ? true : undefined,
  act: str(s.act),
  employee: str(s.employee),
});

/** The sheet `act` opens in the accounts view: the invite. */
export type AccountsSheet = { kind: "invite" };
export const sheetOf = (act?: string): AccountsSheet | undefined => (act === "invite" ? { kind: "invite" } : undefined);

/**
 * An unkeyed account command (role, link, (de)activate) whose outcome is unknown: no answer (a network fault), a 5xx,
 * or a 409 that my own first press may have caused. A 4xx otherwise is an answer: nothing was recorded.
 */
export const unknownOutcome = (e: unknown) => {
  if (e instanceof TypeError) return true;
  const status = typeof e === "object" && e !== null && "status" in e ? Number(e.status) : NaN;
  return status === 0 || status >= 500 || status === 409;
};

/** What an account holds once each unkeyed command was recorded: the account read again decides, never a re-send. */
type Held = Pick<components["schemas"]["UserSummary"], "employee_id" | "is_active">;
export const holdsLink = (employeeId: string | null) => (u: Held) => (u.employee_id ?? null) === employeeId;
export const holdsActive = (active: boolean) => (u: Held) => u.is_active === active;
