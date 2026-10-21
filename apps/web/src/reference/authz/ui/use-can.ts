import { useQuery } from "@tanstack/react-query";
import { authzApplies, authzQuery, granted } from "../api";

/** `can(feature)` for gating affordances. The server still enforces every command. */
export function useCan() {
  const q = useQuery({ ...authzQuery, enabled: authzApplies() });
  return granted(q.data?.capabilities, q.isError);
}
