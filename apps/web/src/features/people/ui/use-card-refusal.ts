// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { queryView, type ReadState } from "../../../lib/react/query-view";

export function nextConsoleCardRefusal(detail: ReadState, current: unknown): unknown {
  const view = queryView(detail);
  if (view === "denied" || view === "not-found") return detail.error;
  if (view === "ready" && !detail.isPlaceholderData) return null;
  return current;
}

export function useCardRefusal(detail: ReadState) {
  const [latchedRefusal, setLatchedRefusal] = useState<unknown>(null);
  const nextRefusal = nextConsoleCardRefusal(detail, latchedRefusal);
  if (nextRefusal !== latchedRefusal) setLatchedRefusal(nextRefusal);
  const view = queryView(detail);
  const refusedNow = view === "denied" || view === "not-found";
  const refused = refusedNow || Boolean(detail.isPlaceholderData && latchedRefusal);
  return { refused, refusedNow, latchedRefusal };
}
