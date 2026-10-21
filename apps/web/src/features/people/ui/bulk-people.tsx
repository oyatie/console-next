import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { label } from "../../../lib/labels";
import type { Kind, Row } from "../domain/bulk";
import { EMPLOYMENT_TYPES } from "../domain/register";
import { bulkProblemText } from "../present";
import { suggestTitle, type JobTitle } from "../domain/titles";
import { SelectInput } from "../../../ui/field/select-input";
import s from "./bulk-page.module.css";

type Unit = components["schemas"]["OrgUnitHead"];
const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };

/**
 * The middle pane (spec E6-move): each person, where they are now and where they go, what to check about them (a
 * contract that continues, a reason the server would refuse them), and a way to take them out of the batch.
 */
export function BulkPeople({ kind, rows, pending = 0, units, unitId, position, titles = [], perRow = {}, onPerRow, sub, onDrop, foot, refused, error }: {
  kind: Kind | null;
  rows: readonly Row[];
  /** People picked whose records are still being read: their rows are held (blank) so the page never grows under the user. */
  pending?: number;
  units: readonly Unit[];
  unitId: string;
  position: string;
  /** A promotion's title list (TITLE, ranked): each person's target picked from it, a suggestion offered. */
  titles?: readonly JobTitle[];
  perRow?: Readonly<Record<string, string>>;
  onPerRow?: (key: string, label: string) => void;
  sub: string;
  onDrop: (key: string) => void;
  foot: string;
  /** People the server refused at commit, with its words. */
  refused: ReadonlyMap<string, { message: string }>;
  /** What is still missing on the rows (a promotion with people left without a title). */
  error?: string;
}) {
  const target = kind === "PROMOTE" ? position.trim() : (units.find((u) => u.id === unitId)?.name ?? "");
  // With a title list, each person's promotion is their own (suggested, never preselected).
  const perPerson = kind === "PROMOTE" && titles.length > 0;
  const offers = perPerson ? rows.flatMap((r) => (r.employee && !perRow[r.key] ? [[r.key, suggestTitle(r.employee.position, titles)?.id] as const] : [])).filter((x): x is readonly [string, string] => Boolean(x[1])) : [];
  const check = (r: Row) =>
    r.employee && refused.has(r.employee.id) ? <Chip tone="danger">{t("bulk.result.refused")} · {refused.get(r.employee.id)!.message}</Chip>
    : r.problem ? <Chip tone="danger">{bulkProblemText(r, kind)}</Chip>
    : r.hint ? <Chip tone="warn">{t(`bulk.hint.${r.hint}`)}</Chip>
    : r.employee?.employment_type === "CONTRACT" ? <Chip>{t("bulk.page.contractKeeps")}</Chip>
    : <span className={s.steel}>{"—"}</span>;
  return (
    <section className={s.pane} aria-labelledby="bulk-people">
      <div className={s.paneHead}>
        <h2 id="bulk-people" className={s.paneTitle}>{t(kind === "PROMOTE" ? "bulk.page.peoplePromote" : "bulk.page.people", { n: rows.length })}</h2>
        <small>{sub}</small>
        {/* Drawn with the promotion pick itself (the kinds wait for the title list): the head never grows under the pointer. */}
        {perPerson && <Button aria-disabled={offers.length === 0 || undefined} onClick={() => offers.forEach(([k, v]) => onPerRow?.(k, v))}>{t("bulk.promote.acceptAll", { n: offers.length })}</Button>}
      </div>
      <div className={s.tableWrap}>
        <Table
          label={t(kind === "PROMOTE" ? "bulk.page.peoplePromote" : "bulk.page.people", { n: rows.length })}
          rows={rows.length ? [...rows] : Array.from({ length: pending }, (_, i): Row => ({ key: `pending-${i}`, merged: [], target: "" }))}
          rowId={(r) => r.key}
          columns={[
            { header: t("bulk.page.col.number"), cell: (r) => <span className="num">{r.employee?.employee_number ?? r.number ?? "—"}</span>, fit: true },
            { header: t("bulk.page.col.name"), cell: (r) => <b>{r.employee?.name ?? r.pastedName ?? "—"}</b>, fit: true },
            { header: t("bulk.page.col.position"), cell: (r) => r.employee?.position ?? "—", fit: true },
            { header: t("bulk.page.col.type"), cell: (r) => (r.employee?.employment_type ? label(TYPE, r.employee.employment_type) : "—"), fit: true },
            { header: t("bulk.page.col.now"), cell: (r) => (kind === "PROMOTE" ? (r.employee?.position ?? "—") : (r.employee?.org_unit ?? "—")), fit: true },
            { header: t("bulk.page.col.next"), cell: (r) => (perPerson ? <PromoteCell r={r} titles={titles} value={perRow[r.key] ?? ""} onPick={(v) => onPerRow?.(r.key, v)} /> : <b>{target ? `→ ${target}` : "—"}</b>), fit: !perPerson },
            { header: t("bulk.page.col.check"), cell: check },
            { header: <span className="sr-only">{t("bulk.page.col.drop")}</span>, cell: (r) => (r.key.startsWith("pending-") ? null : <Button variant="ghost" className={s.drop} onClick={() => onDrop(r.key)}>{t("bulk.page.drop")}</Button>), fit: true },
          ]}
        />
      </div>
      {error && <p className={`${s.foot} ${s.err}`} role="alert">{error}</p>}
      <p className={s.foot}>{foot}</p>
    </section>
  );
}

/** One person's promotion: their title after, picked from the list; the suggestion shows until a title is chosen. */
function PromoteCell({ r, titles, value, onPick }: { r: Row; titles: readonly JobTitle[]; value: string; onPick: (label: string) => void }) {
  const offer = suggestTitle(r.employee?.position, titles);
  return (
    <span className={s.promote}>
      <SelectInput aria-label={t("bulk.promote.pick", { name: r.employee?.name ?? "" })} value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="">{offer ? t("bulk.promote.offer", { title: offer.label }) : t("bulk.promote.none")}</option>
        {titles.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </SelectInput>
    </span>
  );
}
