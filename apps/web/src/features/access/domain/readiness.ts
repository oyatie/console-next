// go-live readiness (decision #26, design §5.5): every grant that takes effect at go-live, and the worst cases that would leave
// an HR worker signing in to nothing. Ops is break-glass and never reduced (a DB trigger keeps it), so the tenant itself
// cannot be locked out; the guard here is about the people who sign in next to ops.

export type ReadyAccount = { id: string; name: string; active: boolean; has_passkey: boolean };
export type ReadyGrant = { account_id: string; enforcement: string; manages_access: boolean };
export type Check =
  | { code: "ops_full"; tone: "ok" }
  | { code: "no_grant" | "no_passkey" | "role_inactive"; tone: "bad"; account: ReadyAccount; alsoNoPasskey?: true }
  | { code: "only_ops_manages" | "no_accounts"; tone: "info" };

const LIVE = ["ENFORCED", "PREPARED", "SCHEDULED"];

/**
 * The checks, worst first, one per person: no live grant (also saying when the passkey is missing too), else no passkey.
 * `ops` is the ops account's id; deactivated accounts sign in to nothing and are skipped.
 */
export function readiness(accounts: readonly ReadyAccount[], grants: readonly ReadyGrant[], ops: string | undefined): Check[] {
  const staff = accounts.filter((a) => a.id !== ops && a.active);
  const bad = staff.flatMap((a): Check[] => {
    const mine = grants.filter((g) => g.account_id === a.id);
    const live = mine.filter((g) => LIVE.includes(g.enforcement));
    if (live.length) return a.has_passkey ? [] : [{ code: "no_passkey", tone: "bad", account: a }];
    const code = mine.some((g) => g.enforcement === "ROLE_INACTIVE") ? "role_inactive" : "no_grant";
    return [{ code, tone: "bad", account: a, ...(!a.has_passkey && { alsoNoPasskey: true as const }) }];
  });
  const managers = grants.some((g) => g.manages_access && LIVE.includes(g.enforcement) && staff.some((a) => a.id === g.account_id));
  const info: Check[] = !staff.length ? [{ code: "no_accounts", tone: "info" }] : managers ? [] : [{ code: "only_ops_manages", tone: "info" }];
  return [...bad, { code: "ops_full", tone: "ok" }, ...info];
}

/** How many signing-in accounts would start operations stuck. */
export const blocking = (checks: readonly Check[]) => checks.filter((c) => c.tone === "bad").length;
