import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { MapPin, TriangleAlert } from "lucide-react";
import { Chip } from "../../../ui/chip";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { SelectInput } from "../../../ui/field/select-input";
import { Table } from "../../../ui/table";
import type { Pick, ValueItem } from "../domain/values";
import s from "./bulk.module.css";

/** The pick's value as a ChoiceField option key. */
const keyOf = (p?: Pick) => (!p ? null : p.to === "id" ? `id:${p.id}` : p.to);
const pickOf = (v: string): Pick => (v.startsWith("id:") ? { to: "id", id: v.slice(3) } : { to: v as "create" | "skip" });

/**
 * S7 values: every value the file names that is not an exact match is a required pick, nothing preselected — a near
 * miss is offered as one choice among others, never applied. Exact matches are listed below as decided.
 */
export function ImportValues({ items, picks, onPick, ents }: { items: ValueItem[]; picks: Record<string, Pick>; onPick: (key: string, p: Pick) => void; ents: Node[]; rowCount: number }) {
  const open = items.filter((i) => i.problem);
  const matched = items.filter((i) => i.match);
  const names = new Map(ents.flatMap((e) => [[e.id, e.name] as const, ...e.children.map((w) => [w.id, t("orgBulk.import.sitePath", { entity: e.name, name: w.name })] as const)]));
  const entityName = (id: string | null) => (id ? names.get(id) ?? "" : "");
  const done = (col: ValueItem["column"]) => items.filter((i) => i.column === col && (i.match || picks[i.key])).length;
  const total = (col: ValueItem["column"]) => items.filter((i) => i.column === col).length;
  return (
    <div className={`${s.body} ${s.cols2}`}>
      <section className={`card ${s.card}`} aria-labelledby="values-head">
        <h2 id="values-head" className={s.cardHead}>
          {t("orgBulk.import.step.values")}
          {open.length > 0 && <Chip tone="warn">{t("orgBulk.import.toPick", { count: open.filter((i) => !picks[i.key]).length })}</Chip>}
          <Chip>{t("orgBulk.import.matched", { count: matched.length })}</Chip>
        </h2>
        {open.map((i) => {
          const pool = ents.flatMap((e) => (!i.entityId || e.id === i.entityId ? e.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ id: w.id, name: w.name, entity: e.name })) : []));
          const options =
            i.column === "entity"
              ? [...ents.slice(0, 13).map((e) => ({ value: `id:${e.id}`, label: e.name })), { value: "skip", label: t("orgBulk.import.pick.skip", { count: i.rows }) }]
              : [
                  ...i.candidates.map((c) => ({ value: `id:${c.id}`, label: t("orgBulk.import.pick.link", { name: c.name, entity: i.entityId ? "none" : c.entity }) })),
                  ...(i.entityId ? [{ value: "create", label: t("orgBulk.import.pick.create", { value: i.value, entity: entityName(i.entityId) }) }] : []),
                  { value: "skip", label: t("orgBulk.import.pick.skip", { count: i.rows }) },
                ];
          const problem =
            i.problem === "unknown" ? (i.column === "entity" ? t("orgBulk.import.problem.unknown.entity") : t("orgBulk.import.problem.unknown.workplace", { entity: entityName(i.entityId) }))
            : i.problem === "ambiguous" ? t("orgBulk.import.problem.ambiguous", { value: i.value, count: i.candidates.length })
            : i.problem === "nearMiss" ? t("orgBulk.import.problem.nearMiss", { name: i.candidates[0]!.name })
            : t("orgBulk.import.problem.noEntity");
          return (
            <div key={i.key} className={s.pick}>
              <p className={s.pickHead}>
                <strong>{t("orgBulk.import.quoted", { value: i.value })}</strong>
                <span className="muted">{t("orgBulk.import.rows", { count: i.rows })}</span>
                <span className={s.warn}><TriangleAlert size={14} aria-hidden /> {problem}</span>
              </p>
              {i.sources?.map((source) => <div key={source.cell}>{t("entity.name.importSource", { cell: source.cell, column: source.column, value: source.value })}</div>)}
              {i.brn && <div>{t("entity.name.importBrn", { number: i.brn })}</div>}
              <ul>{i.candidates.map((c) => <li key={c.id}>{t("entity.name.proposedMatch", { name: c.name })}</li>)}</ul>
              <ChoiceField
                label={t("orgBulk.import.pick.label", { value: i.value })}
                required
                options={options}
                value={keyOf(picks[i.key]) && options.some((o) => o.value === keyOf(picks[i.key])) ? keyOf(picks[i.key]) : null}
                onChange={(v) => onPick(i.key, pickOf(v))}
              />
              {i.column === "workplace" && pool.length > 0 && (
                <label className="row">
                  {t("orgBulk.import.pick.other")}
                  <SelectInput value={picks[i.key]?.to === "id" && !options.some((o) => o.value === keyOf(picks[i.key])) ? keyOf(picks[i.key])! : ""} onChange={(e) => onPick(i.key, pickOf(e.target.value))}>
                    <option value="" disabled>{t("orgBulk.import.pick.other")}</option>
                    {pool.map((w) => <option key={w.id} value={`id:${w.id}`}>{t("orgBulk.import.sitePath", { entity: w.entity, name: w.name })}</option>)}
                  </SelectInput>
                </label>
              )}
              {i.problem === "unknown" && i.column === "workplace" && <p className={s.note}>{t("orgBulk.import.createNote")}</p>}
            </div>
          );
        })}
        {matched.length > 0 && (
          <Table
            label={t("orgBulk.import.matchedTable")}
            rows={matched}
            rowId={(r) => r.key}
            columns={[
              { header: t("orgBulk.import.col.source"), cell: (r) => <strong>{r.value}</strong> },
              { header: t("orgBulk.import.rowCol"), fit: true, cell: (r) => <span className="num">{r.rows}</span> },
              { header: t("orgBulk.import.col.target"), cell: (r) => <span className="row"><MapPin size={14} aria-hidden /> {names.get(r.match!)}</span> },
              { header: t("orgBulk.import.col.how"), cell: () => <span className="muted">{t("orgBulk.import.how.exact")}</span> },
            ]}
          />
        )}
      </section>
      <aside className={s.rail}>
        <section className={`card ${s.card}`}>
          <h2 className={s.cardHead}>{t("orgBulk.import.progress")}</h2>
          {(["entity", "workplace"] as const).filter((c) => total(c) > 0).map((c) => (
            <p key={c} className="row">
              <span className="grow">{t(`orgBulk.import.progress.${c}`)}</span>
              <span className="num">{t("orgBulk.import.progress.count", { done: done(c), total: total(c) })}</span>
            </p>
          ))}
        </section>
      </aside>
    </div>
  );
}
