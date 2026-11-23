// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { get } from "../../../lib/query";

/**
 * The signed-in account, and whether it is linked to an employee record. A self-service page sends none of the
 * employee's own reads until `linked`: an account with no record would only be refused them.
 */
export function useEmployeeLink() {
  const me = useQuery(get("/api/v1/users/me"));
  return { me, linked: me.data?.employee_link_status === "LINKED" };
}
