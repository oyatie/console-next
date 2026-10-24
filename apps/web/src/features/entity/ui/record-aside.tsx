import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Ban, FileText, Trash2, TriangleAlert } from "lucide-react";
import type { EntityDocument, LegalEntity, Revision } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtNumber } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { entityEndQuery, entityHistoryQuery } from "../api";
import { refusalText } from "../../../reference/crud/present";
import { useRecordLock } from "./use-record-lock";
import { NtsCheck } from "./nts-check";
import { primaryRegistration } from "../domain/view";
import { headcount } from "../domain/view";
import { recordedDay, revisionKind } from "../domain/history";
import { changeLine } from "../present";
import { reasonText } from "../present";
import type { Act } from "./record-revise-sheet";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/** What still needs doing on this entity (to-dos, never errors): a certificate to enter, a number to compare, a confirmation. */
function todos(e: LegalEntity) {
  return [
    e.registrations.length === 0 && t("entityRecord.todo.noCert"),
    e.needs_confirmation && t("entityRecord.todo.confirm"),
    e.workplaces.length === 0 && t("entityRecord.todo.workplace"),
  ].filter((x): x is string => Boolean(x));
}

/** The side column (spec S3): where the record stands, its latest history, how it closes, and its kept originals. */
export function RecordAside({ e, phase, depts, docs, act, onTab }: { e: LegalEntity; phase?: string; depts: number; docs: EntityDocument[] | null; act: Act; onTab: (tab: "history" | "documents") => void }) {
  const primary = primaryRegistration(e);
  const lock = useRecordLock();
  const locked = lock !== null;
  const setup = phase === "SETUP";
  // CRUD: delete or closure is decided by use, in either phase (the server's end-options read; the phase until it answers).
  const end = useQuery(entityEndQuery(e.id)).data;
  const erase = end ? end.delete.allowed : setup;
  const history = useQuery({ ...entityHistoryQuery(e.id), retry: false });
  const items: Revision[] = history.data?.items ?? [];
  const left = todos(e);
  return (
    <aside className={s.aside}>
      {primary && <NtsCheck historical={lock === "asof"} registration={primary} entity={e} canManage={e.can_manage && !locked} onAttach={() => act.reissue(primary.id)} />}
      <section className="card" aria-labelledby="state-title">
        <div className={s.cardHead}><h2 id="state-title" className={s.cardTitle}>{t("entityRecord.state.title")}</h2><Chip tone={setup ? "ok" : "info"}>{t(setup ? "entityRecord.phase.setup" : "entityRecord.phase.operating")}</Chip></div>
        <div className={s.cardBody}>
          <div className={s.stats}>
            <div><small>{t("entityRecord.state.people")}</small><b className="num">{fmtNumber(headcount(e))}</b></div>
            <div><small>{t("entityRecord.state.workplaces")}</small><b className="num">{fmtNumber(e.workplaces.length)}</b></div>
            <div><small>{t("entityRecord.state.depts")}</small><b className="num">{fmtNumber(depts)}</b></div>
          </div>
          {left.length > 0 && <p className={s.todo}><TriangleAlert size={14} aria-hidden /> {t("entityRecord.state.todos", { count: left.length, first: left[0] })}</p>}
        </div>
      </section>
      <section className="card" aria-labelledby="hist-title">
        <div className={s.cardHead}>
          <h2 id="hist-title" className={s.cardTitle}>{t("entityRecord.history.title")}</h2>
          <span className="grow" />
          {history.isSuccess && <Button variant="ghost" onClick={() => onTab("history")}>{t("entityRecord.history.all", { count: items.length })}</Button>}
        </div>
        <ol className={s.timeline}>
          {[...e.scheduled].reverse().filter((x) => !items.slice(0, 4).some((r) => r.version === x.version)).map((x) => (
            <li key={`s${x.version}`} data-t="plan"><span className={s.when}>{t("entityRecord.history.scheduled", { date: fmtDate(x.effective_from) })}</span><b>{t("entityRecord.history.scheduledWhat")}</b></li>
          ))}
          {items.slice(0, 4).map((r) => {
            const kind = revisionKind(r);
            const derived = kind === "derived" || kind === "declared";
            const future = r.effective_from > (e.as_of ?? todayKst());
            return (
              <li key={r.version} data-t={kind === "corrected" ? "fix" : kind === "created" ? "new" : "rev"}>
                {/* The record time is an instant: its day is Korea's, never the UTC date's (TS-21). */}
                <span className={s.when}>{fmtDateTime(r.recorded_at)}{r.effective_from !== recordedDay(r.recorded_at) && ` · ${t(future ? "entityRecord.history.scheduled" : "entityRecord.history.from", { date: fmtDate(r.effective_from) })}`}</span>
                <b>{t(`entityRecord.history.${kind}`)}</b>
                {/* company-19: what changed, old → new, and why (the first two fields; the history tab has them all). */}
                {!derived && r.changes.length > 0 && <span>{[r.changes.slice(0, 2).map(changeLine).join(" · "), reasonText(r.reason_code)].filter(Boolean).join(" · ")}</span>}
                {kind !== "derived" && <span className={s.when}>{r.actor_name}</span>}
                <Link to="/org/entities/$id" params={{ id: e.id }} search={{ as_of: r.effective_from, known_at: r.recorded_at }}>{t("asof.viewMoment")}</Link>
              </li>
            );
          })}
          {history.isError && <li className="muted">{t("entity.history.logPending")}</li>}
        </ol>
      </section>
      {/* worst-case-08: a reader who may not manage this entity is offered no way to end it. */}
      {(e.can_manage || e.closed_on) && <section className="card" aria-labelledby="close-title">
        <div className={s.cardHead}><h2 id="close-title" className={s.cardTitle}>{t("entityRecord.close.title")}</h2></div>
        <div className={s.cardBody}>
          {e.closed_on ? (
            <p>{t("entityRecord.close.closed", { date: fmtDate(e.closed_on) })}</p>
          ) : erase ? (
            <>
              <p><b>{t("entityRecord.close.delete")}</b> <Muted>{t("entityRecord.close.deleteWhat", { workplaces: e.workplaces.length, depts, people: fmtNumber(headcount(e)) })}</Muted></p>
              {!e.read_only && <Button variant="ghost-danger" id="act-entity-delete" onClick={() => { if (!e.read_only) act.remove(); }}><Trash2 size={16} aria-hidden /> {t("entityRecord.close.deletePreview")}</Button>}
            </>
          ) : (
            <>
              <p className="row"><Ban size={14} aria-hidden /><b>{t("entityRecord.close.end")}</b> <Muted>{t("entityRecord.close.endWhat")}</Muted></p>
              {end?.delete.refusal && <p className="muted">{refusalText(end.delete.refusal)}</p>}
              {!e.read_only && <Button id="act-entity-close" onClick={() => { if (!e.read_only) act.close(); }}>{t("entityRecord.close.endPlan")}</Button>}
            </>
          )}
        </div>
      </section>}
      {docs && (
        <section className="card" aria-labelledby="docs-title">
          <div className={s.cardHead}>
            <h2 id="docs-title" className={s.cardTitle}>{t("entityRecord.docs.title")}</h2>
            <span className="grow" />
            <Button variant="ghost" onClick={() => onTab("documents")}>{t("entityRecord.docs.all", { count: docs.length })}</Button>
          </div>
          <ul className={s.mlist}>
            {docs.slice(0, 3).map((d) => <li key={d.id}><FileText size={14} aria-hidden /><span>{d.file_name} · {fmtDateTime(d.uploaded_at)}</span></li>)}
            {docs.length === 0 && <li className="muted">{t("entityRecord.docs.none")}</li>}
          </ul>
        </section>
      )}
    </aside>
  );
}
