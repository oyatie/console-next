import { createContext, useContext } from "react";
import { readGroup } from "../../../lib/react/query-view";
import { useQuery } from "@tanstack/react-query";
import { accountsQuery, catalogQuery, meQuery, opsQuery, rolesQuery, type Account } from "../api";

export const AccessAccountContext = createContext<Account | undefined>(undefined);

/** What every grant screen reads: the catalog, the roles to grant, the accounts, who I am, who ops is, and the phase. */
export function useAccessContext() {
  const account = useContext(AccessAccountContext);
  const cat = useQuery(catalogQuery);
  const roles = useQuery(rolesQuery);
  const accounts = useQuery(accountsQuery);
  const me = useQuery(meQuery);
  const ops = useQuery(opsQuery);
  return {
    q: readGroup([cat, roles, accounts, me, ops]),
    cat,
    roles: roles.data?.items ?? [],
    /** Wait for the arrival read before opening a sheet: cached empty roles would flash a notice. */
    rolesLoaded: roles.isSuccess && roles.isFetchedAfterMount,
    accounts: account ? [account, ...(accounts.data?.items ?? []).filter(a => a.id !== account.id)] : accounts.data?.items ?? [],
    accountsQ: accounts,
    me: me.data?.account_id,
    ops: ops.data?.account_id,
    setup: me.data?.phase !== "OPERATING",
  };
}
