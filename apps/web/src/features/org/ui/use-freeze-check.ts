import { useQuery } from "@tanstack/react-query";
import { get } from "../../../lib/query";
import { useCan } from "../../../reference/authz/ui/use-can";

/**
 * The active payroll or accounting lock `date` falls in, if any: a change dated inside it cannot be applied
 * (or archived) while the lock stands, the server refuses it then. Only lock managers can read the locks,
 * so for anyone else this is always null.
 * newest 200 locks; the server's own preflight warning (FREEZE_WINDOW_REVIEW) covers the rest.
 */
export function useFreezeCheck(date: string) {
  const can = useCan();
  const locks = useQuery({ ...get("/api/v1/period-locks", { params: { query: { limit: 200 } } }), enabled: can("period_lock_manage") && date !== "" });
  return locks.data?.items.find((l) => !l.unlockedAt && l.periodStart <= date && date <= l.periodEnd) ?? null;
}
