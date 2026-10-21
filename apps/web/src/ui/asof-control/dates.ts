import { isDate } from "../date/days";

export function nearestDate(dates: readonly string[], value: string, direction: "previous" | "next") {
  return dates.filter((date) => isDate(date) && (direction === "previous" ? date < value : date > value)).sort().at(direction === "previous" ? -1 : 0);
}


/** A calendar cutoff or an exact RFC3339 recording instant from a history link. */
export function isKnowledgeDate(value: string) {
  return isDate(value) || (isDate(value.slice(0, 10))
    && /^\d{4}-\d{2}-\d{2}[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && Number.isFinite(Date.parse(value)));
}
