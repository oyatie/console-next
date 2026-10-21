import { entityNames } from "../../../reference/entity/domain/names";
// The company structure as the chart, outline and registry read it: tenant → legal entity → workplace → department (any depth,
// decision #18), built from GET /org-structure and enriched from the entity list (BRN, representative, address, head office and primary flags).
// Only what the server serves is carried (CS-BE: a department's dated head and code, the server's sibling order, a
// workplace's kind, a legal entity's unplaced count); a workplace's manager is not served (spec §3 C), so nothing here invents it.
import type { LegalEntity, OrgStructure, OrgStructureNode } from "@console/api/pending";
import { todayKst } from "../../../lib/pure/today";

export type Kind = "tenant" | "entity" | "site" | "dept";
export type Phase = OrgStructure["phase"];
export type Chip = OrgStructureNode["chips"][number];

export type ChartNode = {
  id: string;
  kind: Kind;
  name: string;
  alias?: string | null;
  headcount: number;
  chips: readonly Chip[];
  /** SITE/DEPARTMENT version, sent back as expected_version. */
  version?: number;
  /** The org unit a department is placed under: a department's own id, a workplace's own unit. */
  unitId?: string;
  entityId?: string;
  /** The workplace a department sits in. */
  siteId?: string;
  parentId?: string;
  depth: number;
  children: ChartNode[];
  /** legal entity: the registration number masked to its first 6 digits; null when no registration is held yet. */
  brn?: string | null;
  /** The digits of every registration number it holds (searchable, never shown). */
  brnKey?: string;
  reps?: { first: string; more: number };
  /** workplace: province and district of its address. */
  area?: string;
  /** workplace: its kind's label (factory, lab …), when one is chosen. */
  siteKind?: string;
  /** legal entity: people in it placed at no workplace yet; tenant: people with no legal entity yet. */
  unplaced?: number;
  headOffice?: boolean;
  primary?: boolean;
  /** department: its head (null: vacant), named and marked (concurrent) when they belong elsewhere or head another department too. */
  head?: { name: string; concurrent: boolean } | null;
  /** department: its code, when it has one. */
  code?: string;
  scheduledBy?: NonNullable<OrgStructureNode["scheduled_by"]>;
  changedAfter?: boolean;
  diffMarks?: readonly ("new" | "moved" | "renamed" | "gone")[];
};

export type Structure = { root: ChartNode; byId: Map<string, ChartNode>; phase: Phase; counts: { entities: number; sites: number; depts: number }; asOf: string; knownAt?: string; readOnly: boolean };

const KIND: Record<OrgStructureNode["kind"], Kind> = { LEGAL_ENTITY: "entity", WORKPLACE: "site", SITE: "site", DEPARTMENT: "dept" };

/** "000-00-00000" → "220-81-*****": the chart is shared on screens and paper, the serial is not needed there. */
export const maskBrn = (display: string) => display.replace(/(\d{3}-\d{2}-)\d{5}$/, "$1*****");

function enrich(n: ChartNode, entities: ReadonlyMap<string, LegalEntity>) {
  if (n.kind === "entity") {
    const e = entities.get(n.id);
    if (!e) return;
    const names = entityNames(e);
    n.name = names.name || n.name;
    n.alias = names.aliases.join(" · ") || null;
    const primary = e.registrations.find((r) => r.holder_workplace_id === e.primary_workplace_id) ?? e.registrations.find((r) => !r.closed_on);
    n.brn = primary?.brn ? maskBrn(primary.brn.display) : null;
    n.brnKey = e.registrations.map((r) => r.brn?.value ?? "").join(" ");
    const reps = e.current?.representatives;
    if (reps?.length) n.reps = { first: reps[0]!, more: reps.length - 1 };
  }
  if (n.kind === "site" && n.entityId) {
    const e = entities.get(n.entityId);
    const w = e?.workplaces.find((x) => x.id === n.id);
    if (!e || !w) return;
    const a = w.current?.address;
    n.area = a ? [a.si_nm, a.sgg_nm].filter(Boolean).join(" ") : undefined;
    n.headOffice = w.is_head_office;
    n.primary = w.is_primary;
    n.brnKey = e.registrations.filter((r) => r.holder_workplace_id === w.id).map((r) => r.brn?.value ?? "").join(" ");
  }
}

/**
 * The tree with parents, depth and the legal entity/workplace each node belongs to; `entities` may be empty (still
 * loading), and `kindOf` names a workplace kind code (undefined while the kind list loads).
 */
export function buildStructure(s: OrgStructure, entities: readonly LegalEntity[] = [], kindOf: (code: string) => string | undefined = () => undefined): Structure {
  const byEntity = new Map(entities.map((e) => [e.id, e]));
  const byId = new Map<string, ChartNode>();
  const counts = { entities: 0, sites: 0, depts: 0 };
  const walk = (src: OrgStructureNode, parent: ChartNode): ChartNode => {
    const kind = KIND[src.kind];
    const n: ChartNode = {
      id: src.id,
      kind,
      name: src.name,
      headcount: src.headcount,
      chips: src.chips,
      version: src.version,
      scheduledBy: src.scheduled_by ?? undefined,
      changedAfter: src.changed_after ?? false,
      unitId: kind === "dept" ? src.id : (src.org_unit_id ?? undefined),
      entityId: kind === "entity" ? src.id : parent.entityId,
      siteId: kind === "site" ? src.id : parent.siteId,
      parentId: parent.id,
      depth: parent.depth + 1,
      children: [],
      ...(kind === "dept" ? { head: src.head?.name ? { name: src.head.name, concurrent: src.head.concurrent } : null, code: src.code ?? undefined } : {}),
      ...(kind === "site" && src.workplace_kind ? { siteKind: kindOf(src.workplace_kind) } : {}),
      ...(kind === "entity" && src.direct_headcount > 0 ? { unplaced: src.direct_headcount } : {}),
    };
    counts[kind === "entity" ? "entities" : kind === "site" ? "sites" : "depts"] += 1;
    byId.set(n.id, n);
    enrich(n, byEntity);
    n.children = src.children.map((c) => walk(c, n));
    return n;
  };
  const root: ChartNode = { id: "tenant", kind: "tenant", name: s.tenant_name, headcount: 0, chips: [], depth: 0, children: [] };
  byId.set(root.id, root);
  root.children = s.entities.map((e) => walk(e, root));
  // People with no legal entity today count in the tenant and the tenant box says so (served to a tenant-wide caller only).
  const unknown = s.entity_unknown_headcount ?? 0;
  root.headcount = root.children.reduce((sum, e) => sum + e.headcount, 0) + unknown;
  if (unknown > 0) root.unplaced = unknown;
  return { root, byId, phase: s.phase, counts, asOf: s.as_of ?? todayKst(), knownAt: s.known_at ?? undefined, readOnly: s.read_only ?? false };
}

/** Every node under `n` (not `n`), depth first in the server's order. */
export function descendants(n: ChartNode, out: ChartNode[] = []): ChartNode[] {
  for (const c of n.children) {
    out.push(c);
    descendants(c, out);
  }
  return out;
}

/** The path from the root to `id` (root first, `id` last); empty when `id` is not in the tree. */
export function pathTo(s: Structure, id: string): ChartNode[] {
  const out: ChartNode[] = [];
  for (let n = s.byId.get(id); n; n = n.parentId ? s.byId.get(n.parentId) : undefined) out.unshift(n);
  return out;
}

/** `id`, or the nearest of the units it sits in that `shown` holds (the chart draws no box inside a compact workplace). */
export const drawnAt = (s: Structure, shown: ReadonlyMap<string, unknown>, id: string) => pathTo(s, id).reverse().find((n) => shown.has(n.id))?.id;

/** The department count under a node (any depth). */
export const deptCount = (n: ChartNode) => descendants(n).filter((d) => d.kind === "dept").length;
/** People at a workplace in no department: its roll-up less its department' roll-ups. */
export const siteDirect = (n: ChartNode) => Math.max(0, n.headcount - n.children.reduce((s, c) => s + c.headcount, 0));
/** The level a new child of `n` takes: the admin never picks a unit type (decision #18). */
export const childKind = (n: ChartNode): Kind => (n.kind === "tenant" ? "entity" : n.kind === "entity" ? "site" : "dept");
