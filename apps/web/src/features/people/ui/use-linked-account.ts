import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { get } from "../../../lib/query";

type Employee = components["schemas"]["Employee"];

/** Directory accounts matching a search (server-side: the directory is never loaded whole). */
export const directorySearch = (search: string, includeInactive = false) =>
  ({ ...get("/api/v1/directory/people", { params: { query: { search, include_inactive: includeInactive, limit: 20 } } }), enabled: search.length > 0 });

/** This employee's linked sign-in account, once the directory has answered (`mine.isSuccess`); a failed read is never "unlinked". */
export function useLinkedAccount(employee: Employee) {
  // The directory search also matches a linked account's employee number, so the number finds this
  // record's account. a record without a number searches by name and misses an account
  // named otherwise; add an employee_id filter to /directory/people if import rows lack numbers.
  const mine = useQuery(directorySearch(employee.employee_number || employee.name, true));
  return { mine, linked: mine.data?.items.find((p) => p.employee_id === employee.id) };
}
