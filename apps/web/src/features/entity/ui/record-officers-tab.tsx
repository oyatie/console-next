import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { DIRECTOR_ROLE, label, REPRESENTATION } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { entityFields } from "./record-entity-fields";
import type { Act } from "./record-revise-sheet";
import { useRecordLock } from "./use-record-lock";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/** officers (spec S3 tab): the representatives and the registry's officers, each list with its own edit. */
export function OfficersTab({ e, act }: { e: LegalEntity; act: Act }) {
  const c = e.current;
  const f = entityFields(e);
  const open = !useRecordLock();
  return (
    <div className={s.col}>
      <section className="card" aria-labelledby="reps-title">
        <div className={s.cardHead}>
          <h2 id="reps-title" className={s.cardTitle}>{t("entityRecord.field.representatives")}</h2>
          {c?.representation_mode && <Muted>{label(REPRESENTATION, c.representation_mode)}</Muted>}
          <span className="grow" />
          {open && c?.representatives && <Button variant="ghost" onClick={() => act.field(f.representatives)}>{t("entityRecord.officers.fixReps")}</Button>}
        </div>
        <ul className={s.mlist}>
          {(c?.representatives ?? []).map((n) => <li key={n}>{n}</li>)}
          {!c?.representatives && <li className="muted">{t("entity.field.restricted")}</li>}
        </ul>
      </section>
      {e.biz_kind === "CORPORATION" && (
        <section className="card" aria-labelledby="dirs-title">
          <div className={s.cardHead}>
            <h2 id="dirs-title" className={s.cardTitle}>{t("entityRecord.field.directors")}</h2>
            <Muted>{t("entityRecord.officers.basis")}</Muted>
            <span className="grow" />
            {open && c?.directors && <Button variant="ghost" onClick={() => act.field(f.directors)}>{t("entityRecord.officers.fixDirectors")}</Button>}
          </div>
          <ul className={s.mlist}>
            {(c?.directors ?? []).map((d, i) => (
              <li key={i}><b>{label(DIRECTOR_ROLE, d.role)}</b><span>{d.name}</span><span className={s.r}>{d.appointed_on ? t("entityRecord.registry.appointed", { date: fmtDate(d.appointed_on) }) : ""}</span></li>
            ))}
            {c?.directors?.length === 0 && <li className="muted">{t("entityRecord.officers.none")}</li>}
          </ul>
        </section>
      )}
      <p className="muted">{t("entityRecord.registry.noRrn")} · {t("entityRecord.registry.noRrnBasis")}</p>
    </div>
  );
}
