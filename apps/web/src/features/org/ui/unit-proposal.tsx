import { useQueries, useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { parentOf } from "../../../reference/org/present";
import { UnitPicker } from "../../../reference/org/ui/unit-picker";
import { changesByStatusQuery, OPEN_CHANGE_STATUSES } from "../api";
import { namesakes, type Intent, type Unit } from "../domain/proposal";
import { moveTargets, PARENT_KINDS } from "../domain/tree";
import { ProposeShell, type Check } from "./propose-shell";
import { DissolveCard, ReassignCard } from "./unit-members";
import { Context, NameInput, UnitDiff } from "./unit-parts";
import { kindName, okOr, unitKit, useValues, type UnitKit } from "./use-unit-kit";
import { useOrgRouted } from "./use-org-routed";

type Change = components["schemas"]["OrgChangeDetail"];
type Summary = components["schemas"]["OrgChangeSummary"];
export type UnitIntent = Extract<Intent, { kind: "create" | "rename" | "move" | "dissolve" | "reassign" }>;
type Card<I extends UnitIntent["kind"]> = { intent: Extract<UnitIntent, { kind: I }>; units: Unit[]; open: Summary[]; onClose: () => void };

/** The unit intents. Each drafts one org change through POST /org-changes, its date and reason included. */
export function UnitProposal({ intent, units, onClose }: { intent: UnitIntent; units: Unit[]; onClose: () => void }) {
  const open = useQuery(changesByStatusQuery(OPEN_CHANGE_STATUSES)).data?.items ?? [];
  const unit = intent.kind === "create" ? intent.parent : intent.unit;
  // A REORG on the unit may move its members or rename it; only its detail says which. one read per such change.
  const reorgs = intent.kind === "dissolve" ? open.filter((c) => c.kind === "REORG" && c.target.kind === "ORG_UNIT" && c.target.ref === unit.id) : [];
  const moving = useQueries({ queries: reorgs.map((c) => get("/api/v1/org-changes/{id}", { params: { path: { id: c.id } } })) })
    .map((q) => q.data)
    .find((d): d is Change => Boolean(d?.proposal.some((op) => op.op === "REASSIGN_ORG_UNIT" && op.fromOrgUnit === unit.id)));
  switch (intent.kind) {
    case "create": return <CreateCard intent={intent} units={units} open={open} onClose={onClose} />;
    case "rename": return <RenameCard intent={intent} units={units} open={open} onClose={onClose} />;
    case "move": return <MoveCard intent={intent} units={units} open={open} onClose={onClose} />;
    case "dissolve": return <DissolveCard intent={intent} units={units} open={open} moving={moving} onClose={onClose} />;
    case "reassign": return <ReassignCard intent={intent} units={units} open={open} onClose={onClose} />;
  }
}

function CreateCard({ intent: i, units, open, onClose }: Card<"create">) {
  const [v, set] = useValues();
  const routed = useOrgRouted();
  const k: UnitKit = unitKit(units, v, open, undefined, routed);
  const kind = kindName(i.child);
  const field = t("orgPropose.field.name", { kind });
  const op = { op: "CREATE_ORG_UNIT", kind: i.child as "SITE" | "DEPARTMENT" | "TEAM", parentId: i.parent.kind === "COMPANY" ? null : i.parent.id, name: k.name } as const;
  return (
    <ProposeShell intent={i} v={v} set={set} onClose={onClose} spec={(kit) => ({
      title: t("orgPropose.title.create", { parent: i.parent.name, kind }),
      context: (
        <Context rows={[
          { label: t("orgPropose.ctx.parent"), value: k.path(i.parent) },
          { label: t("orgPropose.ctx.kind"), value: kind, basis: t("orgPropose.ctx.kind.basis", { parentKind: kindName(i.parent.kind), kind }) },
          { label: t("orgPropose.ctx.children"), value: k.kidNames(i.parent) },
        ]} />
      ),
      inputs: <NameInput kit={kit} k={k} kind={i.child} label={field} siblings={k.kids(i.parent)} parent={i.parent} />,
      diff: <UnitDiff units={units} op={op} then={k.then} note={t("orgPropose.diff.noMembers")} summary={t("orgPropose.summary.create", { parent: i.parent.name, name: k.name || t("orgPropose.diff.unnamed", { kind }) })} />,
      checks: [{ tone: "ok", text: t("orgPropose.checks.nesting", { parent: i.parent.name, kind }) }],
      consequence: k.consequence(),
      submitLabel: t("orgPropose.submit.create", { name: k.name || kind }),
      dated: true,
      append: k.into(op),
      // The ref is the parent: the new unit has no id until the change applies.
      create: (key) => k.post(key, { kind: "NEW", target: { kind: "ORG_UNIT", ref: i.parent.id, label: k.name }, proposal: [op] }),
    })} />
  );
}

function RenameCard({ intent: { unit }, units, open, onClose }: Card<"rename">) {
  const [v, set] = useValues();
  const routed = useOrgRouted();
  const k = unitKit(units, v, open, undefined, routed);
  const parent = k.byId(parentOf(unit, k.company?.id));
  const sub = k.kids(unit).length;
  const changed = k.name !== "" && k.name !== unit.name;
  const op = { op: "RENAME_ORG_UNIT", orgUnitId: unit.id, name: k.name } as const;
  return (
    <ProposeShell intent={{ kind: "rename", unit }} v={v} set={set} onClose={onClose} spec={(kit) => ({
      title: t("orgPropose.title.rename", { name: unit.name }),
      context: (
        <Context note={k.headcountNote} rows={[
          { label: t("orgPropose.ctx.target"), value: k.path(unit) },
          { label: t("orgPropose.ctx.renamed"), value: t("orgPropose.ctx.renamed.value", { count: unit.headcount, sub }) },
        ]} />
      ),
      inputs: (
        <NameInput kit={kit} k={k} kind={unit.kind} label={t("orgPropose.field.newName")} parent={parent} siblings={parent ? k.kids(parent).filter((u) => u.id !== unit.id) : []}
          hint={changed ? t("orgPropose.field.name.echo", { from: k.path(unit), to: k.name }) : t("orgPropose.field.name.current", { name: unit.name })} />
      ),
      diff: changed ? <UnitDiff units={units} op={op} then={k.then} summary={t("orgPropose.summary.rename", { from: unit.name, to: k.name })} /> : null,
      checks: okOr([]),
      related: k.onTarget(unit),
      consequence: k.consequence(t("orgPropose.consequence.rename", { count: unit.headcount, sub })),
      submitLabel: t("orgPropose.submit.rename", { name: unit.name }),
      dated: true,
      append: k.into(op),
      create: (key) => k.post(key, { kind: "REORG", target: { kind: "ORG_UNIT", ref: unit.id, label: k.name }, proposal: [op] }),
    })} />
  );
}

function MoveCard({ intent: { unit }, units, open, onClose }: Card<"move">) {
  const [v, set] = useValues();
  const routed = useOrgRouted();
  const k = unitKit(units, v, open, undefined, routed);
  const from = k.byId(parentOf(unit, k.company?.id));
  const options = moveTargets(units, unit);
  const to = k.byId(v.parent);
  const count = k.rollup(unit);
  const op = { op: "MOVE_ORG_UNIT", orgUnitId: unit.id, parentId: v.parent } as const;
  const sub = k.kids(unit).length;
  const same = to ? namesakes(unit.name, k.kids(to))[0] : undefined;
  const blocked = options.length ? undefined : unit.kind === "SITE" ? t("orgPropose.move.siteFixed") : t("orgPropose.move.noParent", { kinds: (PARENT_KINDS[unit.kind] ?? []).map(kindName).join(", ") });
  const checks: Check[] = [
    ...(blocked ? [{ tone: "block" as const, text: blocked }] : to ? [{ tone: "ok" as const, text: t("orgPropose.checks.nesting", { parent: to.name, kind: kindName(unit.kind) }) }] : []),
    ...(same && to ? [{ tone: "caution" as const, text: t("orgPropose.field.name.duplicate", { parent: to.name, count: same.headcount }) }] : []),
  ];
  return (
    <ProposeShell intent={{ kind: "move", unit }} v={v} set={set} onClose={onClose} spec={(kit) => ({
      title: t("orgPropose.title.move", { name: unit.name }),
      context: (
        <Context note={k.headcountNote} rows={[
          { label: t("orgPropose.ctx.target"), value: k.path(unit) },
          { label: t("orgPropose.ctx.currentParent"), value: from ? k.path(from) : "—" },
          { label: t("orgPropose.ctx.carried"), value: t("orgPropose.ctx.carried.value", { count, sub }) },
        ]} />
      ),
      inputs: kit.wrap("parent", (
        <div className="field">
          <UnitPicker units={units} options={options} value={kit.v.parent} onChange={(x) => kit.set("parent", x)} labelText={t("orgPropose.field.parent")} />
          <p className="muted">{t("orgPropose.field.parent.hint", { path: from ? k.path(from) : "—" })}</p>
          {kit.error("parent") != null && <p className="field__error">{kit.error("parent")}</p>}
        </div>
      )),
      diff: to && from ? <UnitDiff units={units} op={{ op: "MOVE_ORG_UNIT", orgUnitId: unit.id, parentId: to.id }} then={k.then} summary={t("orgPropose.summary.move", { name: unit.name, from: from.name, to: to.name, count })} /> : null,
      checks: okOr(checks),
      related: k.onTarget(unit),
      consequence: k.consequence(t("orgPropose.consequence.move", { count, sub })),
      submitLabel: t("orgPropose.submit.move", { name: unit.name }),
      block: blocked ? { reason: blocked } : undefined,
      dated: true,
      append: blocked ? undefined : k.into(op),
      create: (key) => k.post(key, { kind: "REORG", target: { kind: "ORG_UNIT", ref: unit.id, label: unit.name }, proposal: [op] }),
    })} />
  );
}
