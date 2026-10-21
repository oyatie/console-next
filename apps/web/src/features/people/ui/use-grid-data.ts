import { useQueries } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { factsQuery } from "../api";
import { registerFactsQuery } from "../api/record";
import type { GridKey } from "../domain/grid";
import { useBulkRows } from "./use-bulk-rows";

type Employee = components["schemas"]["Employee"];
const REGISTER: readonly GridKey[] = ["sex", "address", "register_note"];

/**
 * The picked people and, for the columns that need them, the facts the roster row does not carry (the register facts
 * for sex, address and note; the employment facts for the birth date). The current value of each cell comes from here.
 * one read per person per fact group (a grid is a selection, tens of people); a facts column on the list
 * read would make it one.
 */
export function useGridData(picked: ReadonlyMap<string, string>, columns: readonly GridKey[]) {
  const resolved = useBulkRows({ picked }, null, {}, {});
  const people = resolved.rows.map((r) => r.employee).filter((e): e is Employee => Boolean(e));
  const needRegister = columns.some((c) => REGISTER.includes(c));
  const needFacts = columns.includes("birth_date");
  const reg = useQueries({ queries: people.map((e) => ({ ...registerFactsQuery(e.id), enabled: needRegister })) });
  const facts = useQueries({ queries: people.map((e) => ({ ...factsQuery(e.id), enabled: needFacts })) });
  const value = (i: number, key: GridKey): unknown => {
    const e = people[i]!;
    if (REGISTER.includes(key)) return (reg[i]?.data as Record<string, unknown> | undefined)?.[key];
    if (key === "birth_date") return facts[i]?.data?.birth_date;
    return (e as unknown as Record<string, unknown>)[key];
  };
  const ready = resolved.ready && (!needRegister || reg.every((q) => q.isSuccess)) && (!needFacts || facts.every((q) => q.isSuccess));
  return { people, value, ready, updatedAt: (i: number) => people[i]!.updated_at };
}
