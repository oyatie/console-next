import { AlertTriangle, ArrowRight, Pencil } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import { Table } from "../../../ui/table";
import type { bulkPlan, Resolution, Row } from "../domain/bulk-move";
import { Stats } from "../../../reference/org/ui/panel-shell";
import css from "../../../reference/org/ui/structure.module.css";
import s from "./bulk-move.module.css";

type Plan = ReturnType<typeof bulkPlan>;

/**
 * What changes (S8): one row per group that moves (now → new place, sub-units, members, workplace changes), a name
 * clash resolved in place under its row by one of three answers, the exact totals and each workplace's headcount
 * before and after.
 */
export function BulkMoveTable({ plan, targetLabel, onResolve }: { plan: Plan; targetLabel?: string; onResolve: (id: string, r: Resolution | undefined) => void }) {
  const to = (r: Row) => (r.resolution?.kind === "rename" ? `${targetLabel ?? ""} · ${r.resolution.name}` : r.resolution?.kind === "skip" ? t("bulkMove.skipped") : (targetLabel ?? "—"));
  return (
    <div className={css.stack}>
      <Table
        label={t("bulkMove.what")}
        rows={plan.rows}
        rowId={(r) => r.node.id}
        tone={(r) => (r.clash && !r.resolution ? "danger" : undefined)}
        detail={(r) => r.clash && <Clash r={r} targetLabel={targetLabel} onResolve={onResolve} />}
        columns={[
          { header: t("bulkMove.col.group"), cell: (r) => <>{r.node.name}{r.sub > 0 && <div className={css.note}>{t("bulkMove.carried", { count: r.sub })}</div>}</> },
          { header: t("bulkMove.col.fromTo"), cell: (r) => <><div className={css.note}>{r.from.workplace?.name}</div><b>{to(r)}</b></> },
          { header: t("bulkMove.col.sub"), cell: (r) => <span className="num">{r.sub}</span>, fit: true },
          { header: t("bulkMove.col.members"), cell: (r) => <b className="num">{t("orgStructure.peopleCount", { count: r.members })}</b>, fit: true },
          { header: t("bulkMove.col.site"), cell: (r) => <span className="num">{t("orgStructure.peopleCount", { count: r.siteChanged })}</span>, fit: true },
        ]}
      />
      <Stats
        items={[
          { label: t("bulkMove.stat.units"), value: plan.totals.units },
          { label: t("bulkMove.stat.members"), value: plan.totals.members },
          { label: t("bulkMove.stat.site"), value: plan.totals.siteChanged },
          { label: t("bulkMove.stat.ei"), value: plan.totals.eiChanged },
        ]}
      />
      {plan.sites.length > 0 && (
        <Table
          label={t("bulkMove.sites")}
          rows={plan.sites}
          rowId={(x) => x.node.id}
          columns={[
            { header: t("bulkMove.sites"), cell: (x) => x.node.name },
            {
              header: t("orgStructure.stat.people"),
              cell: (x) => (
                <span className="num">
                  <s className="muted">{t("orgStructure.peopleCount", { count: x.node.headcount })}</s> <ArrowRight size={12} aria-label={t("bulkMove.becomes")} /> <b>{t("orgStructure.peopleCount", { count: x.node.headcount + x.change })}</b>
                </span>
              ),
            },
            { header: t("bulkMove.change"), cell: (x) => <span className="num muted">{x.change > 0 ? `+${x.change}` : x.change}</span>, fit: true },
          ]}
        />
      )}
    </div>
  );
}

function Clash({ r, targetLabel, onResolve }: { r: Row; targetLabel?: string; onResolve: (id: string, x: Resolution | undefined) => void }) {
  const res = r.resolution;
  const what = t("bulkMove.clash", { target: targetLabel ?? "", name: r.clash!.name, n: r.clash!.headcount });
  return (
    <fieldset className={s.clash}>
      <legend className={s.clashHead}><AlertTriangle size={14} aria-hidden />{what}</legend>
      <div className="row">
        <Button aria-pressed={res?.kind === "rename"} className={s.pick} onClick={() => onResolve(r.node.id, { kind: "rename", name: res?.kind === "rename" ? res.name : "" })}><Pencil size={14} aria-hidden />{t("bulkMove.rename")}</Button>
        {res?.kind === "rename" && <TextInput aria-label={t("bulkMove.renameLabel", { name: r.node.name })} value={res.name} onChange={(e) => onResolve(r.node.id, { kind: "rename", name: e.target.value })} />}
      </div>
      <div className="row">
        <Button aria-pressed={res?.kind === "merge"} className={s.pick} onClick={() => onResolve(r.node.id, { kind: "merge" })}>{t("bulkMove.merge", { name: r.clash!.name, a: r.members, b: r.clash!.headcount })}</Button>
        <Button aria-pressed={res?.kind === "skip"} className={s.pick} onClick={() => onResolve(r.node.id, { kind: "skip" })}>{t("bulkMove.skip")}</Button>
      </div>
    </fieldset>
  );
}
