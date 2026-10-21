import { t } from "@console/i18n";
import { Table } from "../../../ui/table";
import { addDays } from "../domain/lifecycle";
import type { GroupInput } from "../domain/group-transfer";
import { fmtDayShort } from "../present";
import s from "./lifecycle.module.css";

type Row = { k: string; label: string; value: string };

/**
 * What the one action records on each side (decision #30, spec E5-group-transfer-preview): at the sending legal entity the exit
 * (reason group transfer, last working day the day before), its social-insurance loss and worker register lines and the settlement as chosen; at the
 * receiving legal entity the hire on the date, its acquisition and register lines, service as chosen and the group start date kept. A settled severance
 * opens the sending legal entity's settlement case with its statutory deadlines. Rows fill in as values are picked.
 */
export function GroupPreview({ from, to, place, date, v }: { from: string; to: string; place: string; date: string; v: GroupInput }) {
  const pick = t("groupTransfer.preview.pick");
  const day = (d: string) => (d ? fmtDayShort(d) : pick);
  const severance = v.severance ? t(`groupTransfer.preview.severance.${v.severance}`, { from, to }) : pick;
  const annualLeave = v.annualLeave ? t(`groupTransfer.preview.annualLeave.${v.annualLeave}`, { from, to }) : pick;
  const seniority = v.seniority ? t(`groupTransfer.preview.seniority.${v.seniority}`, { date: day(date), start: day(v.groupStart) }) : pick;
  const sides: { k: string; title: string; rows: Row[] }[] = [
    {
      k: "from",
      title: t("groupTransfer.preview.from", { entity: from }),
      rows: [
        { k: "exit", label: t("groupTransfer.preview.exit"), value: t("groupTransfer.preview.exit.value", { date: date ? day(addDays(date, -1)) : day("") }) },
        { k: "lose", label: t("groupTransfer.preview.lose"), value: t("groupTransfer.preview.filing") },
        { k: "register", label: t("groupTransfer.preview.register"), value: t("groupTransfer.preview.register.exit") },
        { k: "severance", label: t("groupTransfer.severance"), value: severance },
        { k: "annualLeave", label: t("groupTransfer.annualLeave"), value: annualLeave },
      ],
    },
    {
      k: "to",
      title: t("groupTransfer.preview.to", { entity: to }),
      rows: [
        { k: "hire", label: t("groupTransfer.preview.hire"), value: t("groupTransfer.preview.hire.value", { date: day(date), place }) },
        { k: "acquire", label: t("groupTransfer.preview.acquire"), value: t("groupTransfer.preview.filing") },
        { k: "register", label: t("groupTransfer.preview.register"), value: t("groupTransfer.preview.register.hire") },
        { k: "seniority", label: t("groupTransfer.seniority"), value: seniority },
        { k: "group", label: t("groupTransfer.groupStart"), value: day(v.groupStart) },
      ],
    },
  ];
  return (
    <section className={s.block} aria-labelledby="gt-preview">
      <h3 id="gt-preview" className={s.flabel}>{t("groupTransfer.preview")}</h3>
      <div className={s.pair}>
        {sides.map((side) => (
          <Table
            key={side.k}
            label={side.title}
            rows={side.rows}
            rowId={(r) => r.k}
            columns={[
              { header: side.title, cell: (r) => r.label, fit: true },
              { header: t("groupTransfer.preview.recorded"), cell: (r) => r.value },
            ]}
          />
        ))}
      </div>
    </section>
  );
}
