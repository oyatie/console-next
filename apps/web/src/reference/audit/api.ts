// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";

/** Checked only inside the audit area and My access. This decision never reads a stream. */
export const streamAccessQuery = {
  ...get("/api/v1/audit-streams/availability"),
  gcTime: 0,
  staleTime: 0,
  retry: false,
};
