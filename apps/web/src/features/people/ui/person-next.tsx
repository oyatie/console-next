import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { LIFECYCLE_EVENT, LIFECYCLE_STATE, label, labeled } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { CONTRACT_SOON_DAYS, nextItems, type NextItem, type VerbState } from "../domain/lifecycle";
import { fmtDay, fmtRel } from "../present";
import { retirementDate } from "../domain/employment";
import type { LifecycleEvent } from "../api";
import s from "./person.module.css";
import { Muted } from "../../../ui/muted/muted";

type Detail = components["schemas"]["EmployeeDetail"];

/**
 * What is due next for this person (design §3.4), by date: a record that failed to apply, the nearest
 * reservation, the contract end and the expected return. A line naming a record takes you to it in the
 * history (`onShow`, where the history sits elsewhere); its fix opens the action.
 */
export function NextBox({ d, events, verbs, today, onAct, onShow = (id) => focusSoon(`ev-${id}`) }: { d: Detail; events: LifecycleEvent[]; verbs: VerbState[]; today: string; onAct: (act: string) => void; onShow?: (eventId: string) => void }) {
  const items = nextItems(d.employee, d.employment, events, today);
  const offered = (v: VerbState["verb"]) => verbs.some((x) => x.verb === v && x.enabled);
  return (
    <section className="card panel" aria-labelledby="next">
      <h2 id="next" className="panel__title">{t("person.next.title")}</h2>
      {items.length === 0 ? (
        <Muted>{t("person.next.empty")}</Muted>
      ) : (
        <ul className={s.next}>
          {items.map((i) => (
            <li key={i.kind} className={s.nextItem}>
              <Line i={i} today={today} onShow={onShow} />
              {i.kind === "failed" && i.event.event_type !== "TERMINATE" && offered(i.event.event_type) && (
                <Button variant="ghost" onClick={() => onAct(`again:${i.event.id}`)}>{t("person.next.retry")}</Button>
              )}
              {i.kind === "contract" && i.days <= CONTRACT_SOON_DAYS && offered("CONTRACT_RENEWAL") && (
                <Button variant="ghost" onClick={() => onAct("CONTRACT_RENEWAL")}>{t("people.lifecycle.action.CONTRACT_RENEWAL")}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Line({ i, today, onShow }: { i: NextItem; today: string; onShow: (eventId: string) => void }) {
  switch (i.kind) {
    case "failed":
      return (
        <Button variant="ghost" className={s.lineLink} onClick={() => onShow(i.event.id)}>
          <Chip tone="danger">{t("person.next.failed", { action: label(LIFECYCLE_EVENT, i.event.event_type), date: fmtDay(i.event.effective_date) })}</Chip>
        </Button>
      );
    case "event": {
      const state = labeled(LIFECYCLE_STATE, "SCHEDULED");
      const date = i.event.event_type === "TERMINATE" ? retirementDate(i.event.effective_date) : i.event.effective_date;
      return (
        <Button variant="ghost" className={s.lineLink} onClick={() => onShow(i.event.id)}>
          <span>{t("person.next.event", { action: label(LIFECYCLE_EVENT, i.event.event_type), date: fmtDay(date), rel: fmtRel(date, today) })}</span>
          <Chip tone={state.tone}>{state.label}</Chip>
        </Button>
      );
    }
    case "contract": {
      const text = t("person.next.contract", { date: fmtDay(i.date), rel: fmtRel(i.date, today) });
      return i.days < 0 ? <Chip tone="danger">{text}</Chip> : i.days <= CONTRACT_SOON_DAYS ? <Chip tone="warn">{text}</Chip> : <span>{text}</span>;
    }
    case "return":
      return <span>{i.date ? t("person.next.return", { date: fmtDay(i.date) }) : t("person.next.returnUnknown")}</span>;
  }
}
