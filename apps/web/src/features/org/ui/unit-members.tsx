import { Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { i18n, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { label, ORG_CHANGE_STATUS, SETTLEMENT } from "../../../lib/labels";
import { UnitPicker } from "../../../reference/org/ui/unit-picker";
import { Button } from "../../../ui/button/button";
import { reassignTargets, type Intent, type Unit } from "../domain/proposal";
import { ProposeShell, type Check } from "./propose-shell";
import { ChangeLink, Context, UnitDiff } from "./unit-parts";
import { okOr, unitKit, useValues } from "./use-unit-kit";
import { useOrgRouted } from "./use-org-routed";
import s from "./propose.module.css";

type Summary = components["schemas"]["OrgChangeSummary"];
const SHOWN = 8;
const MEMBERS = "ORG_UNIT_ACTIVE_MEMBERS";
const CHILDREN = "ORG_UNIT_ACTIVE_CHILDREN";
const list = (names: string[]) => new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(names);

/**
 * Dissolving a unit. While anyone still belongs to it (on leave included) or a unit is active under it, the
 * server refuses the submit (ORG_UNIT_ACTIVE_MEMBERS / ORG_UNIT_ACTIVE_CHILDREN): the card says so with the fix
 * and keeps the draft savable. Moving the members is its own change, applied before this one can go.
 */
export function DissolveCard({ intent: { unit }, units, open, moving, onClose }: { intent: Extract<Intent, { kind: "dissolve" }>; units: Unit[]; open: Summary[]; moving?: Summary; onClose: () => void }) {
  const nav = useNavigate();
  const [v, set] = useValues();
  const routed = useOrgRouted();
  const k = unitKit(units, v, open, moving?.id, routed);
  const direct = unit.headcount;
  const children = k.kids(unit);
  const parent = k.byId(unit.parentId) ?? k.company;
  const checks: Check[] = [];
  if (direct > 0)
    checks.push({
      tone: "block",
      text: <>{t("orgPropose.checks.members", { count: direct })} {t("orgPropose.checks.members.fixNote")} <span className="code">{MEMBERS}</span></>,
      action: moving ? (
        <ChangeLink c={moving}>{t("orgPropose.checks.members.open", { code: moving.code, status: label(ORG_CHANGE_STATUS, moving.status), date: fmtDate(moving.effectiveDate) })}</ChangeLink>
      ) : (
        <>
          <Button onClick={() => void nav({ to: "/org", search: { sel: unit.id, act: "reassign" } })}>{t("orgPropose.checks.members.fix", { count: direct })}</Button>
          <Link to="/people" search={{ unit: unit.id }}>{t("orgPropose.checks.members.split")}</Link>
        </>
      ),
    });
  if (children.length > 0)
    checks.push({
      tone: "block",
      text: <>{t("orgPropose.checks.children", { count: children.length })} <span className="code">{CHILDREN}</span></>,
      action: <Button onClick={() => void nav({ to: "/org", search: { sel: children[0]!.id } })}>{t("orgPropose.checks.children.show")}</Button>,
    });
  const blocked = direct > 0 ? t("orgPropose.blocked.members") : children.length > 0 ? t("orgPropose.blocked.children") : undefined;
  const items = SETTLEMENT.values.map((x) => label(SETTLEMENT, x)).join(" · ");
  return (
    <ProposeShell intent={{ kind: "dissolve", unit }} v={v} set={set} onClose={onClose} spec={() => ({
      title: t("orgPropose.title.dissolve", { name: unit.name }),
      context: (
        <Context note={k.headcountNote} rows={[
          { label: t("orgPropose.ctx.target"), value: k.path(unit) },
          { label: t("orgPropose.ctx.members"), value: t("orgPropose.ctx.members.value", { direct, total: k.rollup(unit) }) },
          { label: t("orgPropose.ctx.children"), value: k.kidNames(unit) },
        ]} />
      ),
      inputs: null,
      // Dissolution applies at archive, after its settlement items: the after column says so.
      diff: <UnitDiff units={units} op={{ op: "DISSOLVE_ORG_UNIT", orgUnitId: unit.id }} then={t("orgPropose.diff.thenArchive")} summary={t("orgPropose.summary.dissolve", { parent: parent?.name ?? "", name: unit.name })} />,
      checks: blocked ? checks : [{ tone: "ok", text: t("orgPropose.checks.dissolvable") }],
      related: k.onTarget(unit),
      consequence: k.consequence(t("orgPropose.consequence.dissolve", { count: SETTLEMENT.values.length, items, name: unit.name })),
      submitLabel: t("orgPropose.submit.dissolve", { name: unit.name }),
      block: blocked ? { reason: blocked } : undefined,
      dated: true,
      create: (key) => k.post(key, { kind: "DISSOLVE", target: { kind: "ORG_UNIT", ref: unit.id, label: unit.name }, proposal: [{ op: "DISSOLVE_ORG_UNIT", orgUnitId: unit.id }] }),
    })} />
  );
}

/** Moving everyone out of a unit in one approved change (REASSIGN_ORG_UNIT): on-leave members too, their status kept. */
export function ReassignCard({ intent: i, units, open, onClose }: { intent: Extract<Intent, { kind: "reassign" }>; units: Unit[]; open: Summary[]; onClose: () => void }) {
  const [v, set] = useValues();
  const routed = useOrgRouted();
  const k = unitKit(units, v, open, undefined, routed);
  const { unit, members } = i;
  const count = members.headcount;
  const dissolving = new Set(open.filter((c) => c.kind === "DISSOLVE" && c.target.kind === "ORG_UNIT").map((c) => c.target.ref));
  const { options, excluded } = reassignTargets(units, unit, dissolving);
  const to = k.byId(v.to);
  const names = members.items.map((m) => m.name);
  // REASSIGN matches members by company name, as registration records it (the COMPANY node's name).
  const op = { op: "REASSIGN_ORG_UNIT", fromOrgUnit: unit.id, toOrgUnit: v.to, scope: { company: k.company?.name ?? "" } } as const;
  const movers = (
    <>
      {t("orgPropose.ctx.movers", { count })}
      <span className={s.names}>{list(names.slice(0, SHOWN))}</span>
      {count > SHOWN && (
        <details>
          <summary>{t("orgPropose.ctx.moreNames", { count: count - SHOWN })}</summary>
          {list(names.slice(SHOWN))}
        </details>
      )}
    </>
  );
  return (
    <ProposeShell intent={i} v={v} set={set} onClose={onClose} spec={(kit) => ({
      title: t("orgPropose.title.reassign", { name: unit.name, count }),
      context: <Context note={k.headcountNote} rows={[{ label: t("orgPropose.ctx.from"), value: k.path(unit) }, { label: t("orgPropose.ctx.moversLabel"), value: movers }]} />,
      inputs: kit.wrap("to", (
        <div className="field">
          <UnitPicker units={units} options={options} value={kit.v.to} onChange={(x) => kit.set("to", x)} labelText={t("orgPropose.field.to")} />
          {excluded.length > 0 && <p className="muted">{t("orgPropose.field.to.excluded", { names: list(excluded.map((u) => u.name)) })}</p>}
          {kit.error("to") != null && <p className="field__error">{kit.error("to")}</p>}
        </div>
      )),
      diff: to ? (
        <UnitDiff units={units} op={{ op: "REASSIGN_ORG_UNIT", fromOrgUnit: unit.id, toOrgUnit: to.id, scope: { company: "" } }} then={k.then}
          summary={t("orgPropose.summary.reassign", { from: unit.name, to: to.name, count, before: to.headcount, after: to.headcount + count })} />
      ) : null,
      checks: okOr([]),
      related: k.onTarget(unit),
      consequence: k.consequence(t("orgPropose.consequence.reassign", { name: unit.name, count, to: to?.name ?? t("orgPropose.ctx.chosenUnit") })),
      submitLabel: to ? t("orgPropose.submit.reassign", { count, to: to.name }) : t("orgPropose.submit.reassignNoTo", { count }),
      dated: true,
      append: k.into(op),
      create: (key) => k.post(key, { kind: "REORG", target: { kind: "ORG_UNIT", ref: unit.id, label: t("orgPropose.reassignTarget", { name: unit.name }) }, proposal: [op] }),
    })} />
  );
}
