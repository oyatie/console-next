import { Link } from "@tanstack/react-router";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ChangeMode, LegalEntity, Revision } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { CHANGE_MODE, labeled } from "../../../lib/labels";
import { OutcomeLink } from "../../../lib/react/outcome-link";
import { ActorBadge } from "../../../ui/timeline-lanes/actor-badge";
import { Chip } from "../../../ui/chip";
import { Timeline } from "../../../ui/timeline";
import { entityDocumentsQuery, entityHistoryQuery, registrationHistoryQuery } from "../api";
import { OpenOriginal } from "./open-original";
import { revisionKind } from "../domain/history";
import { entityName } from "../../../reference/entity/domain/names";
import { changeLine } from "../present";
import { reasonText } from "../present";

type MomentTarget = { id: string; wp?: string };

/** One dated revision: who recorded it, from which date it holds, how it was decided, and what changed. */
export function RevisionItems({ items, subject, target }: { items: Revision[]; subject?: string; target?: MomentTarget }) {
  return (
    <Timeline
      items={items.map((r, i) => {
        const mode = labeled(CHANGE_MODE, r.change_mode);
        return {
          // Versions repeat across the insurer chains of one workplace; the read's order is stable.
          key: `${i}-${r.version}`,
          at: r.recorded_at,
          title: (
            <span className="row">
              {revisionKind(r) === "derived"
                ? `${t("entityRecord.history.derived")} · ${t("entityRecord.history.from", { date: fmtDate(r.effective_from) })}`
                : r.actor_name
                  ? t("entity.history.line", { actor: r.actor_name, from: fmtDate(r.effective_from), subject: subject ?? "" })
                  : t("entity.history.lineNoActor", { from: fmtDate(r.effective_from), subject: subject ?? "" })}
              <Chip tone={mode.tone}>{mode.label}</Chip>
              {target && <Link to="/org/entities/$id" params={{ id: target.id }} search={{ wp: target.wp, as_of: r.effective_from, known_at: r.recorded_at }}>{t("asof.viewMoment")}</Link>}
              <ActorBadge kind={r.actor_kind} /><OutcomeLink id={r.command_id} />
              {r.evidence_document_id && target && <Evidence id={r.evidence_document_id} entityId={target.id} />}
            </span>
          ),
          // company-19: old → new for each field, and why it was recorded.
          detail: [r.changes.map(changeLine).join(" · "), reasonText(r.reason_code)].filter(Boolean).join(" · ") || undefined,
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

type Known = { version: number; effective_from: string; change_mode: ChangeMode };

/**
 * A record's dated history. Until the revision log is served (a backend request) it shows the states the record
 * read carries: the one in force and any scheduled for a later date, so a future change is never invisible.
 */
export function History({ q, subject, known, target }: { q: UseQueryResult<{ items: Revision[] }>; subject: string; known: Known[]; target: MomentTarget }) {
  if (q.isSuccess) return <RevisionItems items={q.data.items} subject={subject} target={target} />;
  if (q.isPending) return <p className="muted" role="status">{t("common.loading")}</p>;
  return (
    <>
      <Timeline
        items={known.map((k) => {
          const mode = labeled(CHANGE_MODE, k.change_mode);
          return {
            key: `${k.version}`,
            at: k.effective_from,
            title: (
              <span className="row">
                {t("entity.history.state", { from: fmtDate(k.effective_from), subject })}
                <Chip tone={mode.tone}>{mode.label}</Chip>

              </span>
            ),
          };
        })}
      />
      <p className="muted">{t("entity.history.logPending")}</p>
    </>
  );
}

/** The entity's and its certificates' effective-dated history, newest first; nothing is ever overwritten. */
export function HistoryTab({ e }: { e: LegalEntity }) {
  const own = useQuery({ ...entityHistoryQuery(e.id), retry: false });
  const regs = useQueries({ queries: e.registrations.map((r) => ({ ...registrationHistoryQuery(r.id), retry: false })) });
  const states = (c: Known | null | undefined, later: Known[] = []) => [...later].reverse().concat(c ? [c] : []);
  return (
    <section className="card panel" aria-labelledby="history-title">
      <h2 id="history-title" className="panel__title">{t("entity.history.title")}</h2>
      <History target={{ id: e.id }} q={own} subject={entityName(e)} known={states(e.current, e.scheduled)} />
      {e.registrations.map((r, i) => {
        const name = r.brn?.display ?? entityName(e);
        return (
          <section key={r.id} aria-label={t("entity.history.registration", { name })}>
            <h3 className="field__label">{t("entity.history.registration", { name })}</h3>
            <History target={{ id: e.id }} q={regs[i]!} subject={name} known={states(r.current)} />
          </section>
        );
      })}
    </section>
  );
}
