import { useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LegalEntity } from "@console/api/pending";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import { Sheet } from "../../../ui/sheet/sheet";
import { SheetReadContext } from "../../../ui/sheet/read-context";
import { entityQuery } from "../api";

/**
 * The legal entity a workplace sheet decides from, read again as the sheet opens: a cached copy can predate a save
 * made since (a new workplace, the head office, which certificate is free), and a sheet must neither offer choices
 * from it nor change under the pointer when the newer read lands. The form waits for that answer.
 */
export function FreshEntity({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: (e: LegalEntity) => ReactNode }) {
  const q = freshOnOpen(useQuery({ ...entityQuery(id), refetchOnMount: "always" }));
  return <ReadInSheet q={q} title={title} onClose={onClose}>{children}</ReadInSheet>;
}

export function ReadInSheet<T>({ q, title, onClose, children }: { q: ReadState<T>; title: string; onClose: () => void; children: (data: T) => ReactNode }) {
  const view = queryView(q);
  const reads = useContext(SheetReadContext);
  const read = <QueryState q={q} layout="form">{children}</QueryState>;
  // Sheet reads must not insert a page-sized placeholder beside the chart they cover.
  return q.data !== undefined && view !== "denied" && view !== "not-found" ? <SheetReadContext value={[...reads, q]}>{children(q.data)}</SheetReadContext>
    : <Sheet open title={title} onClose={onClose} consequence={null} actions={null}>{read}</Sheet>;
}
