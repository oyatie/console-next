// SPDX-License-Identifier: LicenseRef-Proprietary
import { session } from "@console/api";
import { employeeQuery } from "./employee-read";
import { assignmentsRef, entitiesRef } from "../../../reference/entity/api/reads";
import { unitsQuery } from "../../../reference/org/api/reads";

/** The card's cacheable first reads, shared with the page through their query descriptors. */
export function cardReads(id: string) {
  // SessionRecovery invalidates the router after restoring the principal and its stream.
  if (!session.token || session.lost) return [];
  return [employeeQuery(id), assignmentsRef(id), entitiesRef, unitsQuery];
}
