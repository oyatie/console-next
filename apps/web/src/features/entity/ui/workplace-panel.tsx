import { useQuery } from "@tanstack/react-query";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { workplaceHistoryQuery } from "../api";
import { registrationOf, workplaceName } from "../domain/view";
import { History } from "./history-tab";
import { RegularHeadcount } from "./regular-headcount";
import { VerificationBadge } from "./verification-badge";
import { WorkplaceFacts } from "./workplace-facts";
import { WorkplaceInsurance } from "./workplace-insurance-table";
import s from "./entity.module.css";

/**
 * One workplace beside the legal entity's list: its certificate's status, the same fact rows (each with its own edit) and social insurance block
 * the org chart's side panel shows (WorkplaceFacts, WorkplaceInsurance: one component, two places), its headcounts and history.
 */
export function WorkplacePanel({ e, w }: { e: LegalEntity; w: Workplace }) {
  const history = useQuery({ ...workplaceHistoryQuery(w.id), retry: false });
  const reg = registrationOf(e, w.registration_id);
  const name = workplaceName(w);
  const hid = `wh-${w.id}`;
  const toHistory = () => (document.getElementById(hid)?.scrollIntoView({ block: "start" }), focusSoon(hid));
  return (
    <aside className="card panel" aria-label={name}>
      <div className="panel__head">
        <h2 className="panel__title">{name}</h2>
      </div>
      {reg && <VerificationBadge r={reg} />}
      <WorkplaceFacts e={e} w={w} onHistory={toHistory} />
      <dl className={s.facts}>
        <dt>{t("workplace.col.people")}</dt>
        <dd className="num">{t("entity.count.people", { count: w.headcount })}</dd>
      </dl>
      <RegularHeadcount r={w.regular_workers} />
      <section aria-labelledby={`ins-${w.id}`}>
        <h3 id={`ins-${w.id}`} className="field__label">{t("workplace.field.insurance")}</h3>
        <WorkplaceInsurance e={e} w={w} onHistory={toHistory} />
      </section>
      <section aria-labelledby={hid}>
        <h3 id={hid} className="field__label" tabIndex={-1}>{t("entity.history.title")}</h3>
        <History target={{ id: e.id, wp: w.id }} q={history} subject={name} known={w.current ? [w.current] : []} />
      </section>
    </aside>
  );
}
