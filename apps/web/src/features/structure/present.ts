// Copy built from the structure for the screens: a box's accessible name, a move's effect sentence and each box's
// verbs. Pure TS over the catalogs.
import { t } from "@console/i18n";
import type { MenuAction } from "../../ui/menu/action-menu";
import { descendants, type ChartNode } from "./domain/model";
import { transfers } from "./domain/rules";

const headcount = (count: number) => t("common.headcount", { count });

export { unitCounts } from "../../reference/org/present";

/**
 * What a unit is called on screen. The root is the account's legal entities taken together, never a company: it is named by its
 * legal-entity count, and the account's own name stays in the shell (decision #29).
 */
export const nodeName = (n: ChartNode) => (n.kind === "tenant" ? t("structure.root.name", { count: n.children.length }) : n.name);

/** Accessible name of a box: everything it shows, in reading order (the treeitem's label). */
export function nodeLabel(n: ChartNode): string {
  if (n.kind === "tenant") return [nodeName(n), headcount(n.headcount)].join(", ");
  const level = t(`structure.level.${n.kind}`);
  const extra = n.kind === "site" ? [n.headOffice && t("structure.node.headOffice"), n.primary && t("structure.node.primary")] : [];
  return [n.name, level, headcount(n.headcount), ...extra, ...n.chips.map((c) => t(`structure.chip.${c}`))].filter(Boolean).join(", ");
}

/** A workplace's kind as a word, unless it only repeats the level (the default kind is named like the level). */
export const kindWord = (n: ChartNode) => (n.siteKind && n.siteKind !== t("structure.level.site") ? n.siteKind : undefined);
/** A unit's level, a workplace with its kind ("workplace · factory"). */
export const levelText = (n: ChartNode) => [t(`structure.level.${n.kind}`), kindWord(n)].filter(Boolean).join(" · ");

/** One add verb across the chart, menus, panel head and rows. */
export const addLabel = (n: ChartNode) => t(({ tenant: "structure.tools.addEntity", entity: "structure.tools.addSite", site: "structure.tools.addDept", dept: "structure.tools.addSub" } as const)[n.kind]);

/** What a move does, in one sentence (spec orgTree.drop.effect): what goes, how many people, who changes workplace. */
export function moveEffect(moving: readonly ChartNode[], target: ChartNode): string {
  const name = moving.length === 1 ? moving[0]!.name : t("structure.move.many", { count: moving.length });
  const sub = moving.reduce((n, m) => n + descendants(m).length, 0);
  const people = moving.reduce((n, m) => n + m.headcount, 0);
  const moved = moving.reduce((n, m) => n + transfers(m, target), 0);
  return t("structure.move.effect", { target: target.name, name, sub, people, moved });
}

export type Gestures = {
  add: (n: ChartNode) => void;
  rename: (n: ChartNode) => void;
  move: (n: ChartNode) => void;
  remove: (n: ChartNode) => void;
  focusOn: (n: ChartNode) => void;
  /** The department's merge sheet, and its detail (its side panel). */
  merge?: (n: ChartNode) => void;
  open?: (n: ChartNode) => void;
  /** One place earlier or later among its siblings; undefined where it cannot go (an end). */
  order?: (n: ChartNode, step: -1 | 1) => (() => void) | undefined;
};

/** The verbs a box offers, in menu order, with their keys (R24). Only what the server serves for that level. */
export function menuActions(n: ChartNode, g: Gestures): MenuAction[] {
  const focus = { id: "focus", label: t("structure.menu.focus"), shortcut: "F", onAction: () => g.focusOn(n) };
  const add = { id: "add", label: addLabel(n), shortcut: "A", onAction: () => g.add(n) };
  if (n.kind === "tenant") return [];
  // Reorder (S2-chart-menu): one place earlier or later, where there is one.
  const order = ([[-1, "earlier", "Alt+↑"], [1, "later", "Alt+↓"]] as const).flatMap(([step, id, shortcut]) => {
    const run = g.order?.(n, step);
    return run ? [{ id: `order-${id}`, label: t(`structureChart.menu.${id}`), shortcut, onAction: run }] : [];
  });
  if (n.kind === "entity") return [add, ...order, focus];
  // CRUD: a workplace ends from its box too; the sheet that applies (delete if never used, else close) is drawn by use.
  if (n.kind === "site") return [add, ...order, focus, { id: "delete", label: t("crud.menu.endSite"), danger: true, onAction: () => g.remove(n) }];
  const { merge, open } = g;
  return [
    add,
    { id: "rename", label: t("structure.menu.rename"), shortcut: "F2", onAction: () => g.rename(n) },
    { id: "move", label: t("structure.menu.move"), shortcut: "M", onAction: () => g.move(n) },
    ...order,
    ...(merge ? [{ id: "merge", label: t("structure.menu.merge"), onAction: () => merge(n) }] : []),
    focus,
    ...(open ? [{ id: "open", label: t("structure.menu.open"), shortcut: "Enter", onAction: () => open(n) }] : []),
    { id: "delete", label: t("structure.menu.delete"), shortcut: "Del", danger: true, onAction: () => g.remove(n) },
  ];
}


/** The same temporal marks in the chart, outline, and registry. */
export const temporalLabel = (n: ChartNode) => [
  n.scheduledBy && t("asof.scheduled", { code: n.scheduledBy.code }),
  n.changedAfter && t("asof.changedAfter"),
  ...(n.diffMarks?.map((m) => t(`asof.${m}`)) ?? []),
].filter(Boolean).join(" · ");
