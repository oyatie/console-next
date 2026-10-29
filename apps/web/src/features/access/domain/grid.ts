// The role editor's permission grid (design §2.6, §9.2): domain rows × view / create & edit / approve / export.
// view is implied by any other level (shown as "included", never a separate choice the user must remember).

export const LEVELS = ["view", "edit", "approve", "export"] as const;
export type Level = (typeof LEVELS)[number];

/** One role line as the editor holds it: the levels the user chose, per domain (view only when chosen on its own). */
export type Chosen = Readonly<Record<string, readonly Level[]>>;

/** The levels a domain grants: what was chosen plus view when any other level is (sorted in grid order). */
export const effective = (chosen: readonly Level[]): Level[] =>
  LEVELS.filter((l) => chosen.includes(l) || (l === "view" && chosen.length > 0));

/** view is lit only because another level is chosen (the "included" cell; it cannot be turned off on its own). */
export const autoView = (chosen: readonly Level[]) => !chosen.includes("view") && chosen.some((l) => l !== "view");

/**
 * Toggling one cell. Pressing an auto-included view clears the row (view cannot be removed while a level that needs
 * it stays); any other press flips that level alone.
 */
export function toggle(grid: Chosen, domain: string, level: Level): Chosen {
  const cur = grid[domain] ?? [];
  const next = level === "view" && autoView(cur) ? [] : cur.includes(level) ? cur.filter((l) => l !== level) : [...cur, level];
  const out = { ...grid };
  if (next.length) out[domain] = LEVELS.filter((l) => next.includes(l));
  else delete out[domain];
  return out;
}

/** The lines a save sends: each domain with its effective levels, in catalog order. */
export const toLines = (grid: Chosen, order: readonly string[]) =>
  order.filter((d) => grid[d]?.length).map((domain) => ({ domain, levels: effective(grid[domain]!) }));

/** The grid a stored role reads back as: view stays chosen only where it is the row's only level. */
export const fromLines = (lines: readonly { domain: string; levels: readonly Level[] }[]): Chosen =>
  Object.fromEntries(lines.map((l) => [l.domain, l.levels.length > 1 ? l.levels.filter((x) => x !== "view") : [...l.levels]]));

/** Nothing chosen anywhere: a role with no line grants nothing and cannot be saved. */
export const isEmpty = (grid: Chosen) => Object.values(grid).every((v) => !v.length);

type Offered = { domain: string; grantable: boolean; levels: readonly Level[]; operations: readonly { level: Level }[] };
/** Domains with no console screen in the MVP (Org + HR first): listed as "not yet", never sold as a permission. */
const NO_SCREEN = new Set(["evaluation", "notice"]);
/**
 * The approve level by domain (#26). The org row's is the approval of an org change: until that class routes it does
 * nothing and is not offered. The exit row's is the HQ confirmation (the server still asks for it; under "none" the HR
 * confirmer may give it too) and the exceptions row's is the decision: both always offered. It reads as an approval only
 * on a row whose class the tenant routes.
 */
const OFFERED_WHEN_ROUTED: Readonly<Record<string, string>> = { org: "org_structure" };
const ROUTE_CLASS: Readonly<Record<string, string>> = { org: "org_structure", exit: "exit" };
/** The approval classes the tenant routes (settings `approval.policy.<class>` = route); undefined = not known, offer all. */
export type Routed = ReadonlySet<string> | undefined;
// A Set only: `sellable` is also handed straight to Array.filter, whose second argument is an index.
const decides = (domain: string, routed: Routed) => !(routed instanceof Set) || !(domain in OFFERED_WHEN_ROUTED) || routed.has(OFFERED_WHEN_ROUTED[domain]!);
/** A routed row's approve cell is an approval (governance-03): the word appears only there. */
export const isRoutedApproval = (domain: string, routed: Routed) => routed instanceof Set && domain in ROUTE_CLASS && routed.has(ROUTE_CLASS[domain]!);
/** The approve cell's word: an approval on a routed row, else the domain's own decision (exit confirm, exception decide). */
export const approveWord = (domain: string, routed: Routed): "routed" | "confirm" | "decide" =>
  isRoutedApproval(domain, routed) ? "routed" : domain === "exit" ? "confirm" : "decide";
/**
 * The levels a domain really offers: those the platform tags an operation with, plus view wherever anything is offered
 * (it is implied by every other level); approve only where it decides something today. governance-17: never an empty cell.
 */
export const liveLevels = (d: Offered, routed?: Routed): Level[] =>
  d.levels.filter((l) => (d.operations.some((o) => o.level === l) || (l === "view" && d.operations.length > 0)) && (l !== "approve" || decides(d.domain, routed)));
/** A domain a role can hold today: grantable, with a screen, and at least one level that does something. */
export const sellable = (d: Offered, routed?: Routed) => d.grantable && !NO_SCREEN.has(d.domain) && liveLevels(d, routed).length > 0;
/** The grid's columns: only levels some sellable domain offers. */
export const liveColumns = (domains: readonly Offered[], routed?: Routed): Level[] =>
  LEVELS.filter((l) => domains.some((d) => sellable(d, routed) && liveLevels(d, routed).includes(l)));

/** What editing a held role changes (ROL-M2-role-edit): per domain, the levels added and the levels taken away. */
export function diffLines(before: Chosen, after: Chosen, order: readonly string[]) {
  return order.flatMap((domain) => {
    const was = effective(before[domain] ?? []);
    const now = effective(after[domain] ?? []);
    const added = now.filter((l) => !was.includes(l));
    const removed = was.filter((l) => !now.includes(l));
    return added.length || removed.length ? [{ domain, added, removed }] : [];
  });
}
