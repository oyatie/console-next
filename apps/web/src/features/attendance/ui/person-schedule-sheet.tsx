// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "../../../lib/react/query-state";
import { patternsQuery } from "../api";
import { refusalText } from "../present";
import { AssignSheet, type AssignTarget } from "./assign-sheet";
import { PatternSheet } from "./pattern-sheet";

/** Both records views use the same assignment flow, including the first work pattern. */
export function PersonScheduleSheet({ target, onClose, onAssigned }: { target: AssignTarget; onClose: () => void; onAssigned: (message: string) => void }) {
  const patterns = useQuery(patternsQuery());
  return (
    <QueryState q={patterns} own={refusalText}>
      {(list) => list.items.some((p) => p.status === "ACTIVE") ? (
        <AssignSheet targets={[target]} patterns={list.items} onClose={onClose} onAssigned={(_, message) => onAssigned(message)} />
      ) : (
        <PatternSheet open onClose={onClose} onAdded={() => void patterns.refetch()} />
      )}
    </QueryState>
  );
}
