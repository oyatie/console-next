// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, useContext, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { cursorPages } from "../../../lib/query";
import type { AttentionFilter, InboxFilter } from "../domain/inbox-filter";

export function useInboxArrival(preview: boolean, filter: InboxFilter) {
  const [attention, setAttention] = useState<AttentionFilter>("all");
  // Consumers can mount after a read settles, so their property access cannot drive notifications.
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", preview ? { filter, attention } : { filter }), placeholderData: keepPreviousData, refetchOnMount: "always", notifyOnChangeProps: "all" });
  return { inbox, attention, setAttention };
}

export const InboxReadContext = createContext<ReturnType<typeof useInboxArrival> | null>(null);

export function useInboxRead() {
  return useContext(InboxReadContext)!;
}
