// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { InboxFilter } from "../domain/inbox-filter";
import { InboxReadContext, useInboxArrival } from "./use-inbox-read";

/** Keep the queue's arrival read mounted while its shell waits for supporting reads. */
export function InboxRead({ preview = false, filter = "turn", children }: { preview?: boolean; filter?: InboxFilter; children: ReactNode }) {
  const read = useInboxArrival(preview, filter);
  return <InboxReadContext value={read}>{children}</InboxReadContext>;
}
