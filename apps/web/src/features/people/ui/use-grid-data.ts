import { useQueries } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { readGroup } from "../../../lib/react/query-view";
import { REGISTER_FACTS_BATCH, registerFactsBatchQuery, type RegisterFactsQueryItem } from "../api/record";
import type { GridKey } from "../domain/grid";
import { useBulkRows } from "./use-bulk-rows";

type Employee = components["schemas"]["Employee"];
const FACT_KEYS: readonly GridKey[] = ["sex", "address", "register_note", "birth_date"];

/**
 * The picked people and, for the columns that need them, the facts the roster row does not carry (sex, address,
 * note, and masked birth_date), fetched via chunked `POST /api/v1/employees/register-facts/query` (`<= 500` IDs per call).
 */
export function useGridData(picked: ReadonlyMap<string, string>, columns: readonly GridKey[]) {
  const resolved = useBulkRows({ picked }, null, {}, {});
  const people = resolved.rows.map((r) => r.employee).filter((e): e is Employee => Boolean(e));
  const needFacts = columns.some((c) => FACT_KEYS.includes(c));
  const idChunks = needFacts && people.length > 0
    ? Array.from({ length: Math.ceil(people.length / REGISTER_FACTS_BATCH) }, (_, i) =>
        people.slice(i * REGISTER_FACTS_BATCH, (i + 1) * REGISTER_FACTS_BATCH).map((e) => e.id),
      )
    : [];
  const batchReads = useQueries({ queries: idChunks.map((ids) => registerFactsBatchQuery(ids)) });
  const byId = new Map<string, RegisterFactsQueryItem>();
  for (const read of batchReads) {
    for (const item of read.data?.items ?? []) byId.set(item.employee_id, item);
  }
  const value = (i: number, key: GridKey): unknown => {
    const e = people[i]!;
    if (FACT_KEYS.includes(key)) return (byId.get(e.id) as Record<string, unknown> | undefined)?.[key];
    return (e as unknown as Record<string, unknown>)[key];
  };
  const ready = resolved.ready && (!needFacts || batchReads.every((q) => q.data !== undefined));
  return { q: readGroup([resolved.q, ...(needFacts ? batchReads : [])]), people, value, ready, updatedAt: (i: number) => people[i]!.updated_at };
}
