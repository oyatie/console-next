import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LegalEntity } from "@console/api/pending";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { Sheet } from "../../../ui/sheet/sheet";
import { entityQuery } from "../api";

/**
 * The legal entity a workplace sheet decides from, read again as the sheet opens: a cached copy can predate a save
 * made since (a new workplace, the head office, which certificate is free), and a sheet must neither offer choices
 * from it nor change under the pointer when the newer read lands. The form waits for that answer.
 */
export function FreshEntity({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: (e: LegalEntity) => ReactNode }) {
  const q = freshOnOpen(useQuery({ ...entityQuery(id), refetchOnMount: "always" }));
  const view = queryView(q);
  const read = <QueryState q={q} layout="form">{children}</QueryState>;
  // Sheet reads must not insert a page-sized placeholder beside the chart they cover.
  return q.data !== undefined && view !== "denied" && view !== "not-found" ? read
    : <Sheet open title={title} onClose={onClose} consequence={null} actions={null}>{read}</Sheet>;
}
