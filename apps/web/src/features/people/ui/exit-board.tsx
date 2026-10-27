// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { TimelineLanes } from "../../../ui/timeline-lanes/timeline-lanes";
import { todayKst } from "../../../lib/pure/today";
import { retirementDate } from "../domain/employment";
import type { LifecycleCase } from "../api/lifecycle-trail";
import { trailItemLabel, trailText } from "../present";
import { EXIT_LEGS, exitLeg, exitLegAtRisk, exitPayrollPending, exitDeadlineKnown, exitDeadlineSeverity } from "../domain/exit-legs";
import { TrailItem, TrailCaseEnd } from "./lifecycle-trail-item";
import boardCss from "./exit-board.module.css";

export function ExitBoard({ value, lastWorkingDay, dueSoonDays = null }: { value: LifecycleCase; lastWorkingDay: string; dueSoonDays?: number | null }) {
  const dates = [
    { key: "today", date: todayKst(), title: t("lifecycle.preset.today"), highlight: true },
    { key: "last", date: lastWorkingDay, title: t("exit.field.date") },
    { key: "exit", date: retirementDate(lastWorkingDay), title: t("exit.field.date.loss") + " · " + t("exit.field.date.statutory") },
    ...value.items.filter(item => !exitPayrollPending(item) && exitDeadlineKnown(item)).map(item => ({
      key: item.id, date: item.due_date!, title: trailItemLabel(item.label_key, item.label),
      detail: [item.basis.instrument, item.basis.article].filter(part => typeof part === "string").join(" · "),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return <>
    <Card label={t("exit.board.ribbon")}>
      <TimelineLanes items={dates.map(item => ({ ...item, date: fmtDate(item.date) }))} density="dense" />
    </Card>
    <section aria-label={t("lifecycle.trail.title")} className={boardCss.stack}>
      <h2>{t("lifecycle.trail.title")} <Chip>{trailText(`lifecycle.trail.state.${value.state}`)}</Chip></h2>
      <section aria-label={t("exit.board.board")} className={boardCss.board}>
        {EXIT_LEGS.map(leg => {
          const items = value.items.filter(item => exitLeg(item) === leg);
          const risk = exitLegAtRisk(items, dueSoonDays);
          const overdue = exitLegAtRisk(items, null);
          const label = t(`exit.board.leg.${leg}`);
          return <section key={leg} aria-label={label} className={boardCss.stack}>
            <h3 className={boardCss.heading}><Chip tone={risk ? "warn" : "neutral"}>{label}</Chip>{risk && <Chip tone="warn">{t(overdue ? "exit.board.overdue" : "exit.board.dueSoon")}</Chip>}</h3>
            {items.length ? <ul className={`list-plain ${boardCss.stack}`}>{items.map(item => {
              const payrollPending = exitPayrollPending(item);
              const date = item.due_date && item.due_disposition !== "UNKNOWN" ? <time dateTime={item.due_date}>{fmtDate(item.due_date)}</time> : undefined;
              const deadline = payrollPending ? date : exitDeadlineKnown(item) && item.due_in_days !== null ? <DeadlineChip severity={exitDeadlineSeverity(item.due_in_days, dueSoonDays)} days={item.due_in_days}>{date}</DeadlineChip> : undefined;
              return <li key={item.id} id={`item-${item.id}`}><Card>
                <div className={boardCss.stack}>
                  {payrollPending && <Chip>{t("exit.board.payrollPending")}</Chip>}
                  <TrailItem item={item} value={value} deadline={deadline} />
                  {!item.owner_line && <KeyValue items={[{ key: "owner", label: t("exit.board.owner"), value: t("exit.board.ownerUnknown") }]} />}
                </div>
              </Card></li>;
            })}</ul> : <Card>{t("exit.board.empty")}</Card>}
          </section>;
        })}
      </section>
      <TrailCaseEnd value={value} />
    </section>
  </>;
}
