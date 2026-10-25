import { Link } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { refusedText } from "../present";
import type { Held } from "./use-place-people";
import u from "./unplaced-extra.module.css";

/** Why one person cannot be placed, with what to do: the screen's own words for the placement refusals, else the shared ones. */
const why = (code: string, setup: boolean) => (setup && code === "effective_date_before_hire" ? t("unplaced.why.setup.effective_date_before_hire") : isMessageId(`unplaced.why.${code}`) ? t(`unplaced.why.${code}` as "unplaced.why.stale_record") : refusedText(code));

/**
 * A placement the server would refuse in part (r3:hire-03): nothing was written; each refused person is named with
 * the reason and the way to fix them (their card), and the rest can be placed on their own, or the user cancels and
 * keeps the batch whole.
 */
export function UnplacedRefused({ held, place, pending, onRest, onCancel }: { held: Held; place: string; pending: boolean; onRest: () => void; onCancel: () => void }) {
  const n = held.refused.length;
  return (
    <div className={u.dock}>
      <Banner
        tone="warn"
        live="assertive"
        title={t("unplaced.refused.title", { n, total: n + held.rest.length, place })}
        actions={
          <>
            <Button onClick={onCancel}>{t("unplaced.refused.cancel")}</Button>
            {held.rest.length > 0 && <Button variant="primary" disabled={pending} onClick={onRest}>{t("unplaced.refused.rest", { n: held.rest.length })}</Button>}
          </>
        }
      >
        <p>{t("unplaced.refused.note")}</p>
        <ul className={u.refused} aria-label={t("unplaced.refused.list", { n })}>
          {held.refused.map((r) => (
            <li key={r.person.id}>
              <b>{r.person.name}</b>
              {r.person.employee_number && <span className="num"> {r.person.employee_number}</span>}
              <span> · {why(r.code, held.setup)}</span>
              <Link to="/people/$id" params={{ id: r.person.id }} search={{}} className={buttonClass("ghost")}>{t("unplaced.refused.fix")}</Link>
            </li>
          ))}
        </ul>
      </Banner>
    </div>
  );
}
