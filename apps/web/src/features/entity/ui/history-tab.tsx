import { Link } from "@tanstack/react-router";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { LegalEntity, Revision } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { CHANGE_MODE, labeled } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { OutcomeLink } from "../../../lib/react/outcome-link";
import { ActorBadge } from "../../../ui/timeline-lanes/actor-badge";
import { Chip } from "../../../ui/chip";
import { TimelineLanes } from "../../../ui/timeline-lanes/timeline-lanes";
import { FieldDiff } from "../../../ui/timeline-lanes/field-diff";
import { entityDocumentsQuery, entityHistoryQuery, registrationHistoryQuery } from "../api";
import { OpenOriginal } from "./open-original";
import { revisionKind } from "../domain/history";
import { entityName } from "../../../reference/entity/domain/names";
import { changeField, changeLine, reasonText } from "../present";

type MomentTarget = { id: string; wp?: string };

/** One dated revision: who recorded it, from which date it holds, how it was decided, and what changed. */
export function RevisionItems({ items, subject, target }: { items: Revision[]; subject?: string; target?: MomentTarget }) {
  return (
    <TimelineLanes
      items={items.map((r) => {
        const mode = labeled(CHANGE_MODE, r.change_mode);
        const reason = reasonText(r.reason_code);
        return {
          // Insurer chains can share versions; their field paths distinguish the records.
          key: `${r.recorded_at}-${r.version}-${r.changes.map(c => c.field).join(",")}`,
          date: fmtDateTime(r.recorded_at),
          title: (
            <div className="row">
              {revisionKind(r) === "derived"
                ? `${t("entityRecord.history.derived")} · ${t("entityRecord.history.from", { date: fmtDate(r.effective_from) })}`
                : r.actor_name
                  ? t("entity.history.line", { actor: r.actor_name, from: fmtDate(r.effective_from), subject: subject ?? "" })
                  : t("entity.history.lineNoActor", { from: fmtDate(r.effective_from), subject: subject ?? "" })}
              <Chip tone={mode.tone}>{mode.label}</Chip>
              {target && <Link to="/org/entities/$id" params={{ id: target.id }} search={{ wp: target.wp, as_of: r.effective_from, known_at: r.recorded_at }}>{t("asof.viewMoment")}</Link>}
              <ActorBadge kind={r.actor_kind} /><OutcomeLink id={r.command_id} />
              {r.evidence_document_id && target && <Evidence id={r.evidence_document_id} entityId={target.id} />}
            </div>
          ),
          detail: (
            <>
              {r.changes.map(c => c.field === "registration_id"
                ? <div key={c.field}>{changeLine(c)}</div>
                : <FieldDiff key={c.field} fields={[changeField(c)]} />)}
              {reason && <div className="muted">{reason}</div>}
            </>
          ),
        };
      })}
    />
  );
}

/** The certificate a revision was recorded from (certificate reissue): its file, opened on request. One read of the entity's kept documents serves every revision. */
function Evidence({ id, entityId }: { id: string; entityId: string }) {
  const doc = useQuery({ ...entityDocumentsQuery(entityId), retry: false }).data?.items.find((d) => d.id === id);
  return doc ? <><Chip tone="neutral">{t("entityReissue.history.evidence", { name: doc.file_name })}</Chip><OpenOriginal doc={doc} /></> : null;
}

/** A record's dated history owns its loading, refusal and retry states. */
export function History({ q, subject, target }: { q: UseQueryResult<{ items: Revision[] }>; subject: string; target: MomentTarget }) {
  return <QueryState q={q}>{data => <RevisionItems items={data.items} subject={subject} target={target} />}</QueryState>;
}

/** The entity's and its certificates' effective-dated history, newest first; nothing is ever overwritten. */
export function HistoryTab({ e }: { e: LegalEntity }) {
  const own = useQuery({ ...entityHistoryQuery(e.id), retry: false });
  const regs = useQueries({ queries: e.registrations.map((r) => ({ ...registrationHistoryQuery(r.id), retry: false })) });
  return (
    <section className="card panel" aria-labelledby="history-title">
      <h2 id="history-title" className="panel__title">{t("entity.history.title")}</h2>
      <History target={{ id: e.id }} q={own} subject={entityName(e)} />
      {e.registrations.map((r, i) => {
        const name = r.brn?.display ?? entityName(e);
        return (
          <section key={r.id} aria-label={t("entity.history.registration", { name })}>
            <h3 className="field__label">{t("entity.history.registration", { name })}</h3>
            <History target={{ id: e.id }} q={regs[i]!} subject={name} />
          </section>
        );
      })}
    </section>
  );
}
