import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, MapPin } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { freshOnOpen } from "../../../lib/query";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { FreshEntity } from "./fresh-entity";
import { workplaceName } from "../domain/view";
import type { Place, StructureAct } from "../../../reference/org/domain/structure";
import { cancelClose, CLOSE_READS, closePlanQuery, planClose, refusalsOf, type CloseJob, type ClosePlanView } from "../../../reference/close/api";
import { EMPTY, missing, request, type Draft, type Missing } from "../../../reference/close/domain/plan";
import { CloseJobPanel } from "./close-job";
import { subjectName, whyText } from "../../../reference/close/present";
import { ClosePreview } from "./close-preview";
import { PlanPeople } from "./close-plan-people";
import { ClosePlan } from "./workplace-close-plan";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * Closing a workplace after go-live (S5-close, UX-R2 ENDS): one plan for everyone and every department still there — all to
 * another workplace in one press, per department (moved or dissolved, "all n"), per person in a virtualised table — a preview with
 * exact counts, one confirm. The server applies it on the closing date (now when that is today), all or nothing; the
 * receipt says what it did or will do. A disabled commit always names the one thing left.
 */
export function WorkplaceCloseSheet({ place, onClose, onAct }: { place: Place; onClose: () => void; onAct: (act: StructureAct) => void }) {
  const q = freshOnOpen(useQuery({ ...closePlanQuery(place.node.id), refetchOnMount: "always" }));
  return <QueryState q={q} layout="form">{(view) => <FreshEntity id={place.entity.id}>{(e) => <Body e={e} view={view} place={place} onClose={onClose} onAct={onAct} />}</FreshEntity>}</QueryState>;
}

const blockerText = (m: Missing) =>
  m.what === "role" ? t("workplace.close.blockedRoles")
  : m.what === "date" ? t("workplace.close.blockedDate")
  : m.what === "unit" ? t("workplace.close.blockedUnit", { name: m.name, count: m.count })
  : t("workplace.close.blockedPeople", { name: m.first, count: m.count });

function Body({ e, view, place, onClose, onAct }: { e: LegalEntity; view: ClosePlanView; place: Place; onClose: () => void; onAct: (act: StructureAct) => void }) {
  const today = todayKst();
  const w = e.workplaces.find((x) => x.id === view.workplace_id)!;
  const name = workplaceName(w);
  const [date, setDate] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [receipt, setReceipt] = useState<CloseJob | null>(null);
  const open = view.job && ["SCHEDULED", "WAITING"].includes(view.job.state) ? view.job : null;
  const [replan, setReplan] = useState(false);
  const shown = receipt ?? open ?? (view.job?.state === "FAILED" && !replan ? view.job : null);
  const plan = useCommand({
    run: (_: undefined, key: string) => planClose(key, view.workplace_id, request(view, draft, date)),
    invalidates: CLOSE_READS,
    onSuccess: setReceipt,
    announce: (job) => (job.state === "APPLIED" ? t("workplace.close.done", { name }) : job.state === "WAITING" ? t("workplace.close.waiting", { name, count: job.lines.filter((l) => l.action === "EXIT" && !l.done).length, date: fmtDate(job.closed_on) }) : t("workplace.close.scheduled", { name, date: fmtDate(job.closed_on) })),
  });
  const cancel = useCommand({
    run: (_: undefined, key: string) => cancelClose(key, view.workplace_id),
    invalidates: CLOSE_READS,
    onSuccess: (job) => (setReceipt(null), setReplan(true), void job),
    announce: () => t("workplace.close.cancelled", { name }),
  });
  const left = missing(view, draft, date);
  const refused = refusalsOf(plan.error);
  const counts = left.length === 0 ? request(view, draft, date) : null;
  const kicker = <><MapPin size={14} aria-hidden />{[place.entity.name, name].join(" › ")}</>;
  if (shown) {
    const live = shown.state === "SCHEDULED" || shown.state === "WAITING";
    return (
      <Sheet open wide kicker={kicker} title={t("workplace.close.title", { name })}  onClose={onClose} pending={cancel.isPending}
        notice={<CommandError error={cancel.error} />}
        consequence={<span>{t(`workplace.close.job.${shown.state}`, { date: fmtDate(shown.closed_on) })}</span>}
        actions={<>
          {live && <Button onClick={() => cancel.mutate(undefined)}>{t("workplace.close.cancel")}</Button>}
          {shown.state === "FAILED" && <Button onClick={() => (setReplan(true), setReceipt(null))}>{t("workplace.close.job.replan")}</Button>}
          <Button variant="primary" onClick={onClose}>{t("crud.close")}</Button>
        </>}
      >
        <CloseJobPanel job={shown} view={view} />
      </Sheet>
    );
  }
  const reasonId = "wp-close-reason";
  return (
    <Sheet
      open
      wide
      kicker={kicker}
      title={t("workplace.close.title", { name })}
      onClose={onClose}
      pending={plan.isPending}
      notice={
        <CommandError error={plan.error}>
          {refused.length > 0 && (
            <ul className={css.list}>
              {refused.map((r) => <li key={`${r.employee_id ?? r.org_unit_id}${r.code}`}>{t("workplace.close.refusedLine", { who: subjectName(view, r), why: whyText(r.code) })}</li>)}
            </ul>
          )}
        </CommandError>
      }
      consequence={
        left.length ? (
          <span id={reasonId} className={css.footWarn}><AlertTriangle size={14} aria-hidden />{blockerText(left[0]!)}</span>
        ) : (
          <span>{date === today ? t("workplace.close.consequence", { date: fmtDate(date), name, moves: counts!.people!.filter((p) => p.action === "TRANSFER").length, exits: counts!.people!.filter((p) => p.action === "EXIT").length, groups: counts!.people!.filter((p) => p.action === "GROUP_TRANSFER").length, units: counts!.units!.length }) : t("workplace.close.consequenceLater", { date: fmtDate(date) })}</span>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {left.length ? (
            <Button variant="danger" aria-disabled aria-describedby={reasonId}>{t("workplace.close.submit", { name })}</Button>
          ) : (
            // company-13: the irreversible commit is the danger action; worst-case-24: one request per press (busy while it runs).
            <Button variant="danger" disabled={plan.isPending} onClick={() => !plan.isPending && plan.mutate(undefined)}>{t("workplace.close.submit", { name })}</Button>
          )}
        </>
      }
    >
      <div className={css.two}>
        <DateField label={t("workplace.close.date")} required value={date} onChange={setDate} today={today} min={today} />
        <div className={css.stack}>
          <span className={css.secH}>{t("workplace.close.roles")}</span>
          {view.holds_entity_role ? (
            <span className="row">
              <span className={css.footWarn}>{t("workplace.close.rolesHere")}</span>
              <Button size="sm" onClick={() => onAct("wp-primary")}>{t("workplace.primary.title")}</Button>
            </span>
          ) : (
            <span>{t("workplace.close.rolesElsewhere", { name: workplaceName(e.workplaces.find((x) => x.is_primary && x.id !== w.id) ?? w) || "—" })}</span>
          )}
        </div>
      </div>
      <ClosePlan view={view} draft={draft} entity={place.entity} onDraft={setDraft} />
      {view.people.length > 0 && <PlanPeople view={view} draft={draft} entity={place.entity} date={date} onDraft={setDraft} />}
      <ClosePreview view={view} draft={draft} entity={place.entity} date={date ? fmtDate(date) : t("workplace.close.dateUnset")} insurance={w.insurance.filter((r) => r.status === "ESTABLISHED" || r.status === "ESTABLISHED_NUMBER_PENDING").length} />
    </Sheet>
  );
}
