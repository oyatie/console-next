import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { DeadlineChip } from "./deadline-chip";

export const order = 210;

/** Tone follows the server severity only; the same `days` can be grey (`far`) or amber (`due`). */
export default function DeadlineChips() {
  const what = (n: number) => <b>{tg("sample.person", { n })}</b>;
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiDeadlineChip.name")}</h2>
      <div className="row">
        <DeadlineChip severity="far" days={32} />
        <DeadlineChip severity="due" days={8} />
        <DeadlineChip severity="due" days={0} />
        <DeadlineChip severity="over" days={-2} />
      </div>
      <DeadlineChip severity="over" days={-2} basis={t("exit.ack.korean_labor_law_ack")} interestAccruing>{what(1)}</DeadlineChip>
      <DeadlineChip severity="due" days={14} basis={t("exit.ack.korean_labor_law_ack")}>{what(2)}</DeadlineChip>
      <DeadlineChip severity="far" days={91}>{what(3)}</DeadlineChip>
    </section>
  );
}
