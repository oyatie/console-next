import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { addDays } from "../../../ui/date/days";
import { SelectInput } from "../../../ui/field/select-input";
import { Table } from "../../../ui/table";
import { renewedEnd, type RenewChoice } from "../domain/renew";
import { refusedText } from "../present";
import s from "./bulk-page.module.css";

type Employee = components["schemas"]["Employee"];
const CHOICES: readonly RenewChoice[] = ["renew", "convert", "leave"];

/**
 * One row per person (spec E6-renew): their contract end, what the two-year rule leaves (the server's refusal, once
 * checked), their answer (no default; a person with no contract end is not decided here) and what it makes.
 */
export function RenewTable({ people, choices, onChoice, refused, months, tried }: {
  people: readonly Employee[];
  choices: Readonly<Record<string, RenewChoice>>;
  onChoice: (id: string, c: RenewChoice) => void;
  refused: ReadonlyMap<string, string>;
  months: number;
  tried: boolean;
}) {
  const next = (e: Employee) => {
    const end = e.contract_end_date;
    const c = choices[e.id];
    if (!end) return t("renew.next.noEnd");
    if (c === "renew") return t("renew.next.renew", { end: renewedEnd(end, months) });
    if (c === "convert") return t("renew.next.convert", { date: addDays(end, 1).slice(5) });
    return c === "leave" ? t("renew.next.leave") : "—";
  };
  return (
    <section className={s.pane} aria-label={t("renew.crumb")}>
      <div className={s.tableWrap}>
      <Table
        label={t("renew.crumb")}
        rows={[...people]}
        rowId={(e) => e.id}
        tone={(e) => (refused.has(e.id) ? "danger" : tried && e.contract_end_date && !choices[e.id] ? "warn" : undefined)}
        columns={[
          { header: t("renew.col.number"), cell: (e) => <span className="num">{e.employee_number ?? "—"}</span>, fit: true },
          { header: t("renew.col.name"), cell: (e) => e.name, fit: true },
          { header: t("renew.col.unit"), cell: (e) => e.org_unit ?? "—" },
          { header: t("renew.col.end"), cell: (e) => <span className="num">{e.contract_end_date ?? "—"}</span>, fit: true },
          {
            header: t("renew.col.limit"),
            cell: (e) => (!e.contract_end_date ? t("renew.limit.noEnd") : refused.has(e.id) ? <span className={s.err} title={refusedText(refused.get(e.id)!)}>{t("renew.limit.over")}</span> : t("renew.limit.ok")),
            fit: true,
          },
          {
            header: t("renew.col.how"),
            cell: (e) =>
              e.contract_end_date ? (
                <SelectInput aria-label={t("renew.howOf", { name: e.name })} value={choices[e.id] ?? ""} onChange={(x) => x.target.value && onChoice(e.id, x.target.value as RenewChoice)}>
                  <option value="" disabled>{t("renew.choice.pick")}</option>
                  {CHOICES.map((c) => <option key={c} value={c}>{t(`renew.choice.${c}`)}</option>)}
                </SelectInput>
              ) : null,
          },
          { header: t("renew.col.next"), cell: next },
        ]}
      />
      </div>
    </section>
  );
}
