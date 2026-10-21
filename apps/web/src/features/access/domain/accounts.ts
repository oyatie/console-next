// Who a grant can go to (people-self-47): active accounts, never the ops account, and one entry per person — an
// employee with two accounts (a lost code reissued) is offered once, by the account that can sign in.
type Acc = { id: string; is_active: boolean; has_passkey: boolean; employee_id?: string | null };

export function pickable<A extends Acc>(accounts: readonly A[], ops: string | undefined): A[] {
  const live = accounts.filter((a) => a.is_active && a.id !== ops);
  const best = new Map<string, A>();
  for (const a of live) {
    const key = a.employee_id ?? a.id;
    const held = best.get(key);
    if (!held || (a.has_passkey && !held.has_passkey)) best.set(key, a);
  }
  return live.filter((a) => best.get(a.employee_id ?? a.id) === a);
}
