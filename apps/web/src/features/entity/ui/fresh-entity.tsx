import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LegalEntity } from "@console/api/pending";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { entityQuery } from "../api";

/**
 * The legal entity a workplace sheet decides from, read again as the sheet opens: a cached copy can predate a save
 * made since (a new workplace, the head office, which certificate is free), and a sheet must neither offer choices
 * from it nor change under the pointer when the newer read lands. Nothing shows until that read has answered.
 */
export function FreshEntity({ id, children }: { id: string; children: (e: LegalEntity) => ReactNode }) {
  const q = freshOnOpen(useQuery({ ...entityQuery(id), refetchOnMount: "always" }));
  return <QueryState q={q} layout="form">{children}</QueryState>;
}
