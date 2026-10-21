import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { OutcomeLink } from "../../../lib/react/outcome-link";
import { label, labeled, ORG_CHANGE_KIND, ORG_CHANGE_STATUS } from "../../../lib/labels";
import { daysUntil } from "../domain/lanes";

type Change = components["schemas"]["OrgChangeSummary"];

/** One queue section: a card titled by its list. The heading takes focus after a decision empties a row. */
export function QueueSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card panel" aria-labelledby={id}>
      <h2 id={id} className="panel__title" tabIndex={-1}>{title}</h2>
      {children}
    </section>
  );
}

/** A change's code, kind, target and date, linking to its page. */
export function ChangeLine({ c }: { c: Change }) {
  return (
    <Link to="/org/changes/$id" params={{ id: c.id }} className="grow">
      <span className="code">{c.code}</span> {label(ORG_CHANGE_KIND, c.kind)} · {c.target.label} · <span className="num">{fmtDate(c.effectiveDate)}</span>
    </Link>
  );
}

const NEXT = { DRAFT: "home.mine.edit", PRECHECKED: "home.mine.edit", REJECTED: "home.mine.rejection", SETTLING: "home.mine.settle" } as const;

/** The drafter's own changes waiting on the drafter; each row's link names the next step. */
export function MineList({ changes }: { changes: Change[] }) {
  return (
    <QueueSection id="mine" title={t("home.mine.title")}>
      <ul className="list-plain">
        {changes.map((c) => {
          const st = labeled(ORG_CHANGE_STATUS, c.status);
          const next = NEXT[c.status as keyof typeof NEXT];
          return (
            <li key={c.id} className="row">
              <ChangeLine c={c} />
              <Chip tone={st.tone}>{st.label}</Chip>
              {next && <Link to="/org/changes/$id" params={{ id: c.id }} className="btn">{t(next)}</Link>}
            </li>
          );
        })}
      </ul>
    </QueueSection>
  );
}

/** My changes on someone else's turn: in approval, or approved and due for an apply holder. */
export function WaitingList({ changes }: { changes: Change[] }) {
  if (!changes.length) return <p className="muted">{t("home.waiting.empty")}</p>;
  return (
    <QueueSection id="waiting" title={t("home.waiting.title", { count: changes.length })}>
      <ul className="list-plain">
        {changes.map((c) => {
          const st = labeled(ORG_CHANGE_STATUS, c.status);
          return (
            <li key={c.id} className="row">
              <ChangeLine c={c} />
              <Chip tone={st.tone}>{st.label}</Chip>
              <OutcomeLink id={c.commandId} />
            </li>
          );
        })}
      </ul>
    </QueueSection>
  );
}

/** Calendar days to a date as D-n. Plain text: a deadline's severity is the server's to say (BW-05). */
export const DDay = ({ date, today }: { date: string; today: string }) => <span className="muted num">{t("home.dDay", { days: daysUntil(date, today) })}</span>;

/** Approved changes dated after today, earliest first; each opens its page. */
export function ScheduledList({ changes, today }: { changes: Change[]; today: string }) {
  if (!changes.length) return <p className="muted">{t("home.scheduled.empty")}</p>;
  return (
    <QueueSection id="scheduled" title={t("home.scheduled.title", { count: changes.length })}>
      <ul className="list-plain">
        {changes.map((c) => (
          <li key={c.id} className="row">
            <ChangeLine c={c} />
            <DDay date={c.effectiveDate} today={today} />
          </li>
        ))}
      </ul>
    </QueueSection>
  );
}
