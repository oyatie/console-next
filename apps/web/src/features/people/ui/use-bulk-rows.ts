import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { NUMBERS_PER_READ, ROSTER_PAGE, byNumbersQuery, rosterPageQuery } from "../api";
import { parsePaste, resolvePaste, selectionRows, type Kind, type Row, type SheetTarget, type UnitRef } from "../domain/bulk";

/** Who the batch is for: a paste keyed by employee number, or a roster selection (id → the name seen at the pick). */
export type Source = { paste: string } | { picked: ReadonlyMap<string, string> };

/**
 * The batch's lines matched against the server's records, re-read so the hints and names reflect the records now,
 * not when the rows were picked, and with every status, so a departed employee is named, not "not found". A paste
 * reads just its numbers (as typed and in capitals, since a pasted number matches in any case), 500 to a read; a
 * selection reads the whole roster in the server's largest pages.
 * a selection still takes total/1000 roster reads (4 at 3,000 employees) until GET /employees takes `id[]`.
 */
export function useBulkRows(source: Source, kind: Kind | null, sheet: SheetTarget, picks: Readonly<Record<string, string>>) {
  const paste = "paste" in source;
  const text = paste ? source.paste : "";
  const lines = useMemo(() => parsePaste(text), [text]);
  const on = paste ? lines.length > 0 : source.picked.size > 0;
  const units = useQuery(unitsQuery);
  const numbers = useMemo(() => [...new Set(lines.flatMap((l) => [l.number, l.number.toUpperCase()]).filter(Boolean))], [lines]);
  const chunks = Array.from({ length: Math.ceil(numbers.length / NUMBERS_PER_READ) }, (_, i) => numbers.slice(i * NUMBERS_PER_READ, (i + 1) * NUMBERS_PER_READ));
  const first = useQuery({ ...rosterPageQuery(0), enabled: on && !paste });
  const total = first.data?.total ?? 0;
  const pageReads = useQueries({
    queries: Array.from({ length: paste ? 0 : Math.max(0, Math.ceil(total / ROSTER_PAGE) - 1) }, (_, i) => ({ ...rosterPageQuery((i + 1) * ROSTER_PAGE), enabled: on })),
  });
  const numberReads = useQueries({ queries: chunks.map((c) => ({ ...byNumbersQuery(c), enabled: on })) });
  const reads = paste ? numberReads : [first, ...pageReads];
  const employees = reads.flatMap((p) => p.data?.items ?? []);
  const all = units.data?.items;
  const unitRefs = useMemo<UnitRef[]>(
    () => (all ?? []).filter((u) => u.status === "ACTIVE" && u.kind !== "COMPANY").map((u) => ({ id: u.id, name: u.name, path: unitPath(all ?? [], u) })),
    [all],
  );
  const ready = on && reads.every((p) => p.isSuccess) && units.isSuccess;
  // Re-resolved on each render: a few thousand records, cheaper than keeping memo keys right.
  const rows: Row[] = !ready ? [] : paste ? resolvePaste(lines, { employees, units: unitRefs, kind, sheet, picks }) : selectionRows(source.picked, employees, kind, sheet);
  const checked = numberReads.reduce((n, q, i) => n + (q.isSuccess ? chunks[i]!.length : 0), 0);
  return {
    lines,
    rows,
    ready,
    failed: reads.some((p) => p.isError) || units.isError,
    retry: () => void [...reads, units].forEach((q) => q.isError && q.refetch()),
    progress: paste ? { done: checked, total: numbers.length } : { done: employees.length, total },
    unitRefs,
  };
}
