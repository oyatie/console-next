import { LEAVE_TYPE } from "../../../lib/labels";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { reasonCodesQuery, useNeedsNote, useReasonCodesReady } from "../../../lib/reason-codes";
import { keepsKey } from "../../../lib/react/command";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { inBounds } from "../../../ui/date/days";
import { Receipt } from "../../../ui/receipt/receipt";
import { User } from "lucide-react";
import { LifecycleChanges } from "./lifecycle-changes";
import { unitPath } from "../../../reference/org/present";
import { orgStructureRef } from "../../../reference/entity/api";
import { exitGuardsQuery, jobTitlesQuery, type LifecycleEvent } from "../api";
import { appointmentMode, unitByName, type SheetVerb } from "../domain/lifecycle";
import { moveKind } from "../domain/move";
import { returnRequired } from "../domain/leave";
import { applies, effectivePresets } from "../domain/presets";
import { type JobTitle, activeTitles, currentTitle, DEMOTION_REASON, isDemotion } from "../domain/titles";
import { fmtDay, fmtDayShort, moveOrigin, whoLine } from "../present";
import { Consequence } from "./lifecycle-consequence";
import { Composer } from "../../../ui/composer/composer";
import { useTrailPreview } from "./lifecycle-trail-preview";
import { Changed, LockedDate, Restored } from "./lifecycle-notes";
import { LifecycleRefusal } from "./lifecycle-refusal";
import { LifecycleWhat, LifecycleWhy } from "./lifecycle-what";
import { useLifecycleCommand, VACATE } from "./use-lifecycle-command";
import { useTransferOptions } from "./use-transfer-options";
import { EMPLOYMENT_TYPES } from "../domain/register";

const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };
import { useDraft, type Draft } from "./use-lifecycle-draft";
import type { Offer, Seed } from "./person-act";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
type Unit = components["schemas"]["OrgUnitHead"];
/**
 * One lifecycle action as a side sheet (design §4): what (target), when (the effective date, no default), why (a
 * reason code and its note), then the consequence, the server's sign-offs and the commit. `seed` starts it from a
 * recorded event: a reservation being changed (`edit`: its date kept, replacing it by name), one recorded again
 * (`again`: date empty) or an applied change being corrected (`correct`: kind and date kept, BW-11). The sheet pins
 * the version it read (`head`); a change made since is refused and named, and "read again" re-pins keeping the input.
 */
export function LifecycleSheet({ d: detail, events, head, units, act, offer, seed, changed, onClose, onRecorded, onOpen, onReread }: {
  d: Detail;
  events: readonly LifecycleEvent[];
  /** The employee's lifecycle version the history was read at (BW-11). */
  head: number;
  units: readonly Unit[];
  act: string;
  offer: Offer & { event_type: SheetVerb };
  seed?: Seed;
  /** The record changed since the sheet opened (a refresh): said, never acted on. */
  changed: boolean;
  onClose: () => void;
  onRecorded: (out: LifecycleEvent) => void;
  /** Opens another sheet; `back` is the act its receipt offers to return to. */
  onOpen: (act: string, back?: string) => void;
  /** Reads the history again; resolves to the version now. */
  onReread: () => Promise<number | undefined>;
}) {
  const e = detail.employee;
  const kind = offer.event_type;
  const appointMode = appointmentMode(act, seed?.from);
  const today = todayKst();
  const leaveRules = useQuery({ ...exitGuardsQuery(e.id, today, null), enabled: kind === "LEAVE_OF_ABSENCE" });
  const from = seed?.from;
  const correcting = seed?.mode === "correct" ? from : undefined;
  const locked = seed?.mode === "edit" || Boolean(correcting);
  // A carried unit the employee already belongs to (a reorganization moved them) is said, not prefilled.
  const named = kind === "TRANSFER" ? unitByName(from?.to_org_unit, units.filter((u) => u.kind !== "COMPANY")) : null;
  const carriedUnit = named === e.org_unit_id ? null : named;
  const f = useDraft(e.id, act, {
    date: locked ? from!.effective_date : "",
    unit: carriedUnit ?? "",
    position: kind === "PROMOTE" ? (from?.to_position ?? "") : "",
    gradeId: kind === "PROMOTE" ? (from?.to_grade_id ?? "") : "",
    titleId: kind === "PROMOTE" ? (from?.to_job_title_id ?? "") : "",
    roleId: from?.to_position_kind_id ?? "",
    jobId: from?.to_job_id ?? "",
    familyId: from?.to_job_family_id ?? "",
    reasonCode: from?.reason_code ?? null,
    leaveType: from?.leave_type ?? null,
    returnDate: locked ? (from?.expected_return_date ?? "") : "",
    endDate: locked ? (from?.contract_end_date ?? "") : "",
    toType: locked ? (from?.to_employment_type ?? null) : null,
    comment: locked ? from!.comment : "",
  });
  const v0 = { ...f.draft, ...(kind === "APPOINT" && appointMode === "role" ? { jobId: "", familyId: "" } : kind === "APPOINT" && appointMode === "job" ? { roleId: "" } : {}) };
  const transfer = useTransferOptions(e);
  const placement = useQuery({ ...orgStructureRef, enabled: false });
  const target = transfer.options.find((o) => o.unit.id === v0.unit);
  const actionKind = kind === "TRANSFER"
    ? placement.isSuccess ? moveKind(e.workplace_id, v0.unit ? target?.workplaceId : e.workplace_id) : null
    : kind;
  const fromSite = transfer.workplaces.find((w) => w.id === e.workplace_id)?.current?.name ?? "—";
  const toSite = transfer.workplaces.find((w) => w.id === target?.workplaceId)?.current?.name ?? "—";
  const current = units.find((u) => u.id === e.org_unit_id);
  const origin = moveOrigin(e, current);
  const preview = useTrailPreview(actionKind ? [kind] : [], {
    effective_date: v0.date || undefined,
    variant: actionKind === "relocate" ? "WORKPLACE_CHANGE" : undefined,
  });
  const [tried, setTried] = useState(false);
  const [pin, setPin] = useState(head);
  const [reread, setReread] = useState(false);
  // A reservation of this kind and date the server named (409 scheduled_conflict) that the user chose to replace.
  const [conflict, setConflict] = useState<{ id: string; date: string } | null>(null);
  const what = useRef<HTMLDivElement>(null);
  const titles = useQuery(jobTitlesQuery);
  const items = titles.data?.items ?? [];
  const catalog = activeTitles(items, "TITLE");
  // An appointment picks from the tenant's role, job or job-family list: with all three empty there is nothing to pick.
  // Empty lists lock the sheet only for someone who cannot fill them (the server says who may: can_manage).
  const noCatalog = kind === "APPOINT" && titles.isSuccess && !titles.data.can_manage && !(appointMode === "job" ? ["JOB", "JOB_FAMILY"] : appointMode === "role" ? ["POSITION"] : ["POSITION", "JOB", "JOB_FAMILY"]).some((k) => activeTitles(items, k as JobTitle["kind"]).length);
  const nowTitle = items.find((x) => x.id === detail.classification.job_title_id) ?? currentTitle(events, items);
  const nowGrade = items.find((x) => x.id === detail.classification.grade_id);
  const demotion = kind === "PROMOTE" && (isDemotion(nowTitle, catalog.find((x) => x.id === v0.titleId)) || isDemotion(nowGrade, activeTitles(items, "GRADE").find((x) => x.id === v0.gradeId)));
  const b = locked ? {} : { min: offer.min, max: offer.max };
  // The leave in effect: the latest applied one (its type and expected return feed the return sheet).
  const lastLeave = events
    .filter((x) => x.event_type === "LEAVE_OF_ABSENCE" && x.state === "APPLIED" && !x.voided_by)
    .reduce<LifecycleEvent | undefined>((a, x) => (!a || x.effective_date > a.effective_date ? x : a), undefined);
  const contractEnd = detail.employment?.contract_end_date ?? e.contract_end_date;
  const presets = effectivePresets(kind, { today, ...b, returnDate: lastLeave?.expected_return_date, contractEnd }).map((p) => ({ label: t(`lifecycle.preset.${p.id}`), date: p.date }));
  const pivot = offer.after ?? offer.before;
  const pivotAct = pivot && events.find((x) => x.state === "SCHEDULED" && x.effective_date === pivot);
  const basis = pivot ? t(offer.after ? "lifecycle.basis.after" : "lifecycle.basis.before", { date: fmtDayShort(pivot), action: pivotAct ? label(LIFECYCLE_EVENT, pivotAct.event_type) : "—" }) : undefined;
  const when = applies(v0.date, today) ?? "none";
  const unitName = units.find((u) => u.id === v0.unit)?.name;
  const action = !actionKind ? t("lifecycle.menu.label") : actionKind === "relocate" ? t("lifecycle.menu.relocate") : kind === "APPOINT" && appointMode === "job" ? t("lifecycle.menu.job") : label(LIFECYCLE_EVENT, kind);
  // The reservation this record replaces, by name (BW-11: the server never replaces one silently).
  const sameDay = when === "future" ? events.find((x) => x.state === "SCHEDULED" && x.event_type === kind && x.effective_date === v0.date && x.id !== from?.id) : undefined;
  const replaces = seed?.mode === "edit" ? from!.id : (sameDay?.id ?? (conflict?.date === v0.date ? conflict.id : undefined));
  const coded = kind === "TRANSFER" || kind === "PROMOTE";
  const reasons = useQuery({ ...reasonCodesQuery(kind === "PROMOTE" ? "lifecycle_promote" : "lifecycle_transfer"), enabled: coded });
  const codes = useReasonCodesReady(kind === "TRANSFER" ? "lifecycle_transfer" : kind === "PROMOTE" ? "lifecycle_promote" : null);
  const voidNote = useNeedsNote("lifecycle_cancel", v0.voidCode);
  // Each still-missing input, in screen order; the frame focuses the first after a refused submit.
  const missing = {
    unit: kind === "TRANSFER" && !v0.unit,
    position: kind === "PROMOTE" && !v0.gradeId && (catalog.length > 0 ? !v0.titleId : !v0.position.trim()),
    leaveType: kind === "LEAVE_OF_ABSENCE" && !LEAVE_TYPE.values.some((type) => type === v0.leaveType),
    // A date outside what the server accepts is not sent: the date field says why beside it.
    returnDate: kind === "LEAVE_OF_ABSENCE" && !correcting && ((returnRequired(v0.leaveType) && !v0.returnDate) || (Boolean(v0.returnDate) && when !== "none" && v0.returnDate <= v0.date)),
    endDate: (kind === "CONTRACT_RENEWAL" || (kind === "EMPLOYMENT_TYPE_CHANGE" && v0.toType === "CONTRACT")) && (!v0.endDate || (when !== "none" && v0.endDate < v0.date)),
    appoint: kind === "APPOINT" && (appointMode === "role" ? !v0.roleId : appointMode === "job" ? !v0.jobId && !v0.familyId : !v0.roleId && !v0.jobId && !v0.familyId),
    toType: kind === "EMPLOYMENT_TYPE_CHANGE" && !v0.toType,
    date: when === "none" || !inBounds(v0.date, b.min, b.max),
    reasonCode: coded && codes && (!v0.reasonCode || (demotion && v0.reasonCode !== DEMOTION_REASON)),
    comment: !v0.comment.trim(),
    voidCode: Boolean(replaces || correcting) && !v0.voidCode,
    voidNote: Boolean(correcting) && voidNote && !v0.voidNote.trim(),
    acks: offer.required_signoffs.some((k) => !v0.acks[k]),
  };
  const count = Object.values(missing).filter(Boolean).length;
  const run = useLifecycleCommand({ employeeId: e.id, kind, appointMode, unitName, pin, contractEnd, replaces, corrects: correcting }, v0, (out) => {
    f.done();
    onRecorded(out);
  });
  // A lost response (network fault, 5xx): the outcome is unknown and the key is kept, so the form freezes
  // and the only way on is to ask again under the same key (the server replays what it recorded) or close.
  const checking = run.isError && keepsKey(run.error);
  const v = {
    name: e.name,
    date: when !== "none" ? fmtDay(v0.date) : "",
    from: actionKind === "relocate" ? `${fromSite} › ${origin}` : origin,
    to: actionKind === "relocate" ? `${toSite} › ${unitName}` : unitName ?? t("lifecycle.placeholder.unit"),
    fromPosition: [v0.gradeId ? nowGrade?.label ?? "—" : null, v0.position.trim() ? nowTitle?.label ?? e.position ?? "—" : null].filter(Boolean).join(" · ") || nowTitle?.label || e.position || "—",
    fromGrade: nowGrade?.label ?? "—",
    toGrade: items.find((x) => x.id === v0.gradeId)?.label ?? "—",
    toPosition: [v0.gradeId ? items.find((x) => x.id === v0.gradeId)?.label : null, v0.position.trim()].filter(Boolean).join(" · ") || t("lifecycle.placeholder.position"),
    returnDate: v0.returnDate ? fmtDay(v0.returnDate) : "",
    endDate: v0.endDate ? fmtDay(v0.endDate) : t("lifecycle.placeholder.endDate"),
    fromRole: (titles.data?.items ?? []).find((x) => x.id === detail.classification?.position_kind_id)?.label ?? t("lifecycle.appoint.vacate"),
    toRole: v0.roleId === VACATE ? t("lifecycle.appoint.vacate") : (items.find((x) => x.id === v0.roleId)?.label ?? t("lifecycle.placeholder.role")),
    fromJob: items.find((x) => x.id === detail.classification.job_id)?.label ?? "—",
    toJob: items.find((x) => x.id === v0.jobId)?.label ?? "—",
    fromFamily: items.find((x) => x.id === detail.classification.job_family_id)?.label ?? "—",
    toFamily: items.find((x) => x.id === v0.familyId)?.label ?? "—",
    fromType: detail.employment?.employment_type ? label(TYPE, detail.employment.employment_type) : "—",
    toType: v0.toType ? label(TYPE, v0.toType) : t("lifecycle.placeholder.type"),
  };
  const show = (k: keyof typeof missing) => tried && missing[k];
  const carryNote =
    kind === "TRANSFER" && from?.to_org_unit && !carriedUnit && !correcting ? t(named ? "lifecycle.carry.unitCurrent" : "lifecycle.carry.unitMissing", { name: from.to_org_unit })
    : from && !locked && from.state === "APPLY_FAILED" ? t("lifecycle.carry.failed")
    : from && !locked ? t("person.form.carried", { date: fmtDay(from.effective_date), action: label(LIFECYCLE_EVENT, from.event_type) })
    : undefined;
  const set = (patch: Partial<Draft>) => {
    run.reset();
    setReread(false);
    f.set(patch);
  };
  const refusal = run.isError && !checking && (
    <LifecycleRefusal
      error={run.error}
      kind={kind}
      onLeave={e.status === "ON_LEAVE"}
      target={kind === "TRANSFER" ? origin : (e.position ?? "—")}
      onCancelEvent={(id) => onOpen(`cancel:${id}`, act)}
      onClose={onClose} onGroupTransfer={() => onOpen("GROUP_TRANSFER", act)}
      onFocusTarget={() => what.current?.querySelector<HTMLElement>("input, select")?.focus()}
      onReturn={detail.allowed_events.some((a) => a.event_type === "RETURN_FROM_LEAVE") ? () => onOpen("RETURN_FROM_LEAVE") : undefined}
      onReread={async () => {
        const now = await onReread();
        if (now !== undefined) setPin(now);
        run.reset();
        setReread(true);
      }}
      onReplace={(id, date) => {
        run.reset();
        setConflict({ id, date });
      }}
    />
  );
  // "Now: workplace › department › team · since date": the current place and since when (the last move or the hire).
  const here = current ? unitPath([...units], current) : e.workplace_id ? `${fromSite} › ${origin}` : undefined;
  const since = events.filter((x) => x.state === "APPLIED" && !x.voided_by && ["TRANSFER", "ONBOARD", "REHIRE"].includes(x.event_type)).map((x) => x.effective_date).sort().at(-1) ?? e.hire_date ?? "—";
  const dateControl = (
        locked ? (
          <LockedDate date={v0.date} correcting={Boolean(correcting)} onRebook={() => onOpen(`cancel:${from!.id}`)} />
        ) : (
          <DateField
            label={t(kind === "LEAVE_OF_ABSENCE" ? "lifecycle.leave.start" : "lifecycle.date")}
            required
            today={today}
            value={v0.date}
            onChange={(date) => set({ date })}
            {...b}
            basis={basis}
            presets={presets}
            echo={when === "future" || when === "today" || when === "past" ? t(`lifecycle.when.${when}`) : undefined}
            error={show("date") && when === "none" ? t("lifecycle.date.missing") : undefined}
            showErrors={tried}
          />
        )
  );
  return (
    <Composer
      sections={preview}
      localDraft
      onSaveDraft={onClose}
      kicker={<><User size={12} aria-hidden />{t("lifecycle.kicker", { name: e.name, number: e.employee_number ?? "—", where: [here?.split(" › ").slice(-2).join(" › ") ?? e.org_unit, e.position].filter(Boolean).join(" · ") })}</>}
      title={!actionKind ? action : correcting ? t("lifecycle.title.correct", { name: e.name, action }) : locked ? t("lifecycle.title.change", { name: e.name, action }) : kind === "APPOINT" && appointMode === "job" ? action : t(`lifecycle.title.${actionKind}`)}
      subtitle={here ? t("lifecycle.nowSince", { where: here, date: since }) : t("lifecycle.now", { where: whoLine(e) })}
      onClose={onClose}
      pending={run.isSending}
      loading={titles.isPending || (coded && reasons.isPending) || (kind === "LEAVE_OF_ABSENCE" && leaveRules.isPending)}
      locked={checking || noCatalog}
      blocked={!actionKind ? { reason: t("lifecycle.transfer.placementUnknown") } : undefined}
      notice={
        <>
          {noCatalog && <p className={s.changed} role="status">{t("lifecycle.appoint.noCatalog")}</p>}
          {(changed || reread) && <Changed reread={reread} />}
          {checking && <Receipt state="checking" message={t("lifecycle.checking")} />}
          {refusal}
        </>
      }
      consequence={<><LifecycleChanges kind={kind} e={e} units={units} v={{ ...v0, contractEnd }} words={v} site={{ from: fromSite, to: toSite }} />{actionKind && <Consequence kind={actionKind} appointJob={kind === "APPOINT" && appointMode === "job"} when={when} v={v} replaces={replaces ? fmtDayShort(v0.date) : undefined} corrects={correcting ? fmtDayShort(v0.date) : undefined} />}</>}
      signoffs={{
        items: offer.required_signoffs.map((k) => ({ id: k, label: t(`people.lifecycle.ack.change.${k}`) })),
        value: offer.required_signoffs.filter((k) => v0.acks[k]),
        onChange: (on) => set({ acks: Object.fromEntries(offer.required_signoffs.map((k) => [k, on.includes(k)])) }),
        missing: show("acks"),
      }}
      action={{ kind: kind === "PROMOTE" && demotion ? "demotion" : actionKind ?? "appointment", mode: correcting ? "correct" : locked ? "change" : when === "future" || when === "none" ? "schedule" : "apply", count: 1 }}
      tone={locked || when === "future" || when === "none" ? "primary" : "danger"}
      missing={tried ? count : 0}
      recovery={
        checking ? (
          <>
            <Button onClick={onClose}>{t("composer.dismiss")}</Button>
            <Button variant="primary" onClick={() => run.check()}>{t("lifecycle.checking.ask")}</Button>
          </>
        ) : undefined
      }
      onSubmit={() => {
        setTried(true);
        if (!actionKind || count > 0) return false;
        run.mutate(undefined);
      }}
    >
      {f.restored && <Restored onClear={f.clear} />}
      {correcting && <p className={s.fact}>{t("lifecycle.correct.fact", { date: fmtDay(correcting.effective_date), action })}</p>}
      <LifecycleWhat
        onOpen={onOpen}
        onClose={onClose}
        detail={detail}
        kind={kind}
        appointMode={appointMode}
        v={v0}
        set={set}
        today={today}
        bounds={b}
        lastLeave={lastLeave}
        currentTitle={nowTitle}
        contractEnd={contractEnd}
        show={show}
        note={carryNote}
        correcting={Boolean(correcting)}
        what={what}
        dateSlot={dateControl}
        tried={tried}
      />
      {kind !== "LEAVE_OF_ABSENCE" && (
        <section className={s.section} aria-labelledby="lc-when">
          <h3 id="lc-when" className="sr-only">{t("lifecycle.section.when")}</h3>
          {dateControl}
        </section>
      )}
      <LifecycleWhy kind={kind} v={v0} set={set} demotion={demotion} replaces={Boolean(replaces)} correcting={Boolean(correcting)} voidNote={voidNote} show={show} />
    </Composer>
  );
}
