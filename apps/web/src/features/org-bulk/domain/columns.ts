// Org sheet import, columns step (S7): which column holds the legal entity, the workplace, the department path
// levels, the parent department, the department code and the head's employee number (org-06: the server keeps all three). Pure.
// Headers are matched by known words only; anything else is not imported until the user says so. A shift column is
// named and left out (it is not an org unit).
import { nameKey } from "./outline";

export type Role = "entity" | "brn" | "workplace" | "path" | "parent" | "code" | "head" | "skip";
/** Why a recognised column stays out: it is not an org unit at all (shift). */
export type Unsupported = "shift";
export type ColumnMap = { header: string; role: Role; unsupported?: Unsupported };

/** The header words per role, from the catalog (orgBulk.header.*, comma-separated) so they follow the locale. */
export type HeaderWords = Record<Exclude<Role, "skip" | "brn"> | Unsupported, readonly string[]> & { brn?: readonly string[] };
/** The roles a column can take, in the order the choice lists them. */
export const ROLES: readonly Role[] = ["entity", "brn", "workplace", "path", "parent", "code", "head", "skip"];

/** A header's comparable form: NFC, no spaces, a trailing level number dropped ("Department 1" reads as "Department"). */
const headerKey = (h: string) => nameKey(h).toLocaleLowerCase().replace(/\s+/g, "").replace(/\d+$/, "");

/** The header row: the first row with two or more filled cells. */
export const headerRow = (rows: string[][]) => Math.max(0, rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2));

/** One role per column from its header; the first entity and workplace columns win, every path word is a level. */
export function guessColumns(headers: string[], words: HeaderWords): ColumnMap[] {
  const is = (role: keyof HeaderWords, k: string) => words[role]?.some((w) => headerKey(w) === k);
  const seen = new Set<Role>();
  return headers.map((header) => {
    const k = headerKey(header);
    const role = (["entity", "brn", "workplace", "parent", "code", "head", "path"] as const).find((r) => is(r, k));
    if (role && (role === "path" || !seen.has(role))) {
      seen.add(role);
      return { header, role };
    }
    return { header, role: "skip", ...(is("shift", k) ? { unsupported: "shift" as const } : {}) };
  });
}

/**
 * One data row as the columns read it: entity and workplace cells, the path levels left to right (blanks dropped), and the
 * parent department, code and head employee number cells ("" when the column is not mapped or the cell is blank).
 */
export type SourceCell = { cell: string; column: string; value: string };
export type SheetRow = { brn?: string; entitySource?: SourceCell; line: number; entity: string; workplace: string; path: string[]; parent: string; code: string; head: string };
export function readRows(rows: string[][], header: number, cols: ColumnMap[]): SheetRow[] {
  const at = (role: Role) => cols.findIndex((c) => c.role === role);
  const e = at("entity"), w = at("workplace");
  const cell = (r: string[], i: number) => (i >= 0 ? nameKey(r[i] ?? "") : "");
  const paths = cols.flatMap((c, i) => (c.role === "path" ? [i] : []));
  return rows
    .map((r, i) => ({ r, line: i + 1 }))
    .slice(header + 1)
    .filter(({ r }) => r.some((c) => c.trim()))
    .map(({ r, line }) => ({
      line,
      brn: cell(r, at("brn")).replace(/\D/g, ""),
      ...(e >= 0 ? { entitySource: { cell: `${columnLetter(e)}${line}`, column: cols[e]!.header, value: r[e] ?? "" } } : {}),
      entity: e >= 0 ? nameKey(r[e] ?? "") : "",
      workplace: w >= 0 ? nameKey(r[w] ?? "") : "",
      path: paths.map((i) => nameKey(r[i] ?? "")).filter((x) => x && x !== "-" && x !== "—"),
      parent: cell(r, at("parent")),
      code: cell(r, at("code")),
      head: cell(r, at("head")),
    }));
}

/** What the columns step needs before the next: a workplace column and at least one path level. */
export const columnsReady = (cols: ColumnMap[]) => cols.some((c) => c.role === "workplace") && cols.some((c) => c.role === "path");

const columnLetter = (i: number): string => i < 26 ? String.fromCharCode(65 + i) : columnLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + i % 26);
