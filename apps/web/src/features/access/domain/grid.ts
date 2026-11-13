// The role editor's permission grid (design §2.6, §9.2): domain rows × view / create & edit / approve / export.
// view is implied by any other level (shown as "included", never a separate choice the user must remember).

export const LEVELS = ["view", "edit", "approve", "export"] as const;
export type Level = (typeof LEVELS)[number];

/** One role line as the editor holds it: the levels the user chose, per domain (view only when chosen on its own). */
export type Chosen = Readonly<Record<string, readonly Level[]>>;

/** The levels a domain grants: what was chosen plus view when any other level is and the domain offers it (grid order). */
export const effective = (chosen: readonly Level[], offered: readonly Level[] = LEVELS): Level[] =>
  LEVELS.filter((l) => chosen.includes(l) || (l === "view" && chosen.length > 0 && offered.includes("view")));

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

/** The lines a save sends: each catalog domain with its effective levels, in catalog order. */
export const toLines = (grid: Chosen, catalog: readonly { domain: string; levels: readonly Level[] }[]) =>
  catalog.filter((d) => grid[d.domain]?.length).map(({ domain, levels }) => ({ domain, levels: effective(grid[domain]!, levels) }));

/** The grid a stored role reads back as: view stays chosen only where it is the row's only level. */
export const fromLines = (lines: readonly { domain: string; levels: readonly Level[] }[]): Chosen =>
  Object.fromEntries(lines.map((l) => [l.domain, l.levels.length > 1 ? l.levels.filter((x) => x !== "view") : [...l.levels]]));

/** Nothing chosen anywhere: a role with no line grants nothing and cannot be saved. */
export const isEmpty = (grid: Chosen) => Object.values(grid).every((v) => !v.length);

type Offered = { domain: string; grantable: boolean; levels: readonly Level[]; operations: readonly { level: Level }[] };
/** Domains with no console screen in the MVP (Org + HR first): listed as "not yet", never sold as a permission. */
const NO_SCREEN = new Set(["evaluation", "notice", "todo_request"]);
const ROUTE_CLASS: Readonly<Record<string, string>> = { org: "org_structure", exit: "exit" };
/** The approval classes the tenant routes (settings `approval.policy.<class>` = route). */
export type Routed = ReadonlySet<string> | undefined;
/** A routed row's approve cell is an approval (governance-03): the word appears only there. */
export const isRoutedApproval = (domain: string, routed: Routed) => routed instanceof Set && domain in ROUTE_CLASS && routed.has(ROUTE_CLASS[domain]!);
/** Org authority prepares approval; exit confirmation and exception decisions keep their own words. */
export const approveWord = (domain: string, routed: Routed): "routed" | "confirm" | "decide" =>
  (domain === "org" || isRoutedApproval(domain, routed)) ? "routed" : domain === "exit" ? "confirm" : "decide";
/**
 * The levels a domain really offers: those the platform tags an operation with, plus view wherever anything is offered
 * (it is implied by every other level); routing controls execution, not which catalogued permissions can be configured.
 */
export const liveLevels = (d: Offered, _routed?: Routed): Level[] =>
  d.levels.filter((l) => (d.operations.some((o) => o.level === l) || (l === "view" && d.operations.length > 0)));
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
