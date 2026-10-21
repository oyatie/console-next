// The cells an import changes for people on file (spec E7-update), flattened from the dry run's planned rows. Pure.
import type { ImportDeferred, ImportRow } from "./contract";

/**
 * One changed cell: whose (the row's source key, employee number and name), which field, now → file, and the
 * procedure that owns it when the import only names the difference (`route`), else none (recorded as a correction).
 */
export type ChangedCell = { key: string; number?: string; name: string; field: string; from?: string | null; to?: string | null; route?: ImportDeferred["route"] };

/** Every cell an update row changes, then every difference another procedure owns, in row order. */
export const changedCells = (rows: readonly ImportRow[]): ChangedCell[] =>
  rows.flatMap((r) => [
    ...(r.outcome === "update" ? (r.diff ?? []) : []).map((d) => ({ key: r.source_key, number: r.employee_number, name: r.name, field: d.field, from: d.from, to: d.to })),
    ...(r.deferred ?? []).map((d) => ({ key: r.source_key, number: r.employee_number, name: r.name, field: d.field, from: d.from, to: d.to, route: d.route })),
  ]);
