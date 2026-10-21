import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, CalendarDays, Info, Lock } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTimeShort } from "@console/i18n/format";
import { onRecordChange } from "../../../lib/live/live";
import { useCommand } from "../../../lib/react/command";
import { Banner } from "../../../ui/banner/banner";
import { EntityError } from "./entity-error";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { ENTITY_READS, entityQuery, isStale, readEntity, readVersion, reviseEntity, reviseRegistration } from "../api";
import { dateOf, dayBefore, entityRevision, keepsOldPeriod, nextMonthFirst, registrationRevision, revProblem, scheduledFrom, type EntityPatch, type RegistrationPatch, type Verb, type When } from "../domain/revise";
import { entityName } from "../../../reference/entity/domain/names";
import { Conflict } from "./record-conflict";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/** One recorded fact made editable: what it is now, how to edit it, and what the server receives. */
export type FieldSpec<V> = {
  /** The field's name in copy ("representative"). */
  label: string;
  /** Where it sits: the registry part of the entity or one certificate. */
  group: string;
  /** The entity's facts, or one certificate's. */
  owner: { kind: "entity" } | { kind: "registration"; id: string };
  /** Only a correction makes sense (an opening date never "changes"). */
  corOnly?: boolean;
  current: string;
  initial: V;
  edit: (v: V, set: (v: V) => void) => ReactNode;
  show: (v: V) => string;
  patch: (v: V) => EntityPatch | RegistrationPatch;
  /** The new value can be sent (typed, changed, well formed). */
  ready: (v: V) => boolean;
  /** Why this date ("the appointment date printed in the registry"). */
  dateHint?: string;
  /** Changing it asks for the certificates to be reissued (name, representative, head office). */
  reissue?: boolean;
  /** Nothing is recorded yet (company-31): the first values are entered, dated as printed, with no change-or-correction choice. */
  empty?: boolean;
  /** An entity revision sent through another command (a name review's settle) instead of the plain revise. */
  submit?: (key: string, body: NonNullable<ReturnType<typeof entityRevision>>) => Promise<unknown>;
};

/** What a record card can open: a fact's edit sheet, an identifier's correction, a new certificate, the close or the setup delete. */
export type Act = {
  field: <V>(spec: FieldSpec<V>) => void;
  identifier: (field: "brn" | "crn", registrationId?: string) => void;
  /** certificate reissue: a newly issued certificate and the facts it changed. */
  reissue: (registrationId: string) => void;
  close: () => void;
  remove: () => void;
};

const mmdd = (d: string) => d.slice(5);

/**
 * edit on a recorded fact (spec S3-revise, D7, D10): change (REV) or correction (COR) is chosen first, with nothing preselected; a change
 * then asks from when (today · first of next month · typed, again none preselected) and shows both periods side by side.
 * A correct-only field skips the choice. Nothing is saved until every choice is made.
 */
/** A label ending in a parenthesis ("name (alias)") reads its particle off the word before it (company-22). */
const josaLabel = (label: string) => label.replace(/\s*\([^()]*\)$/, "");

export function ReviseSheet<V>({ e: opened, spec, phase, onClose }: { e: LegalEntity; spec: FieldSpec<V>; phase?: string; onClose: () => void }) {
  // What the sheet was opened on: a refetch while it is open (another person's save) must not move this change onto
  // the newer revision unseen; a save against it that is no longer newest is refused as stale, and the sheet then shows
  // what was recorded meanwhile and moves onto the newest read only when the user says so (Conflict).
  const [e, setE] = useState(opened);
  const latest = useQuery(entityQuery(opened.id));
  const [rebased, setRebased] = useState(false);
  const today = todayKst();
  const [verb, setVerb] = useState<Verb | null>(spec.corOnly || spec.empty ? "cor" : null);
  const [when, setWhen] = useState<When | null>(null);
  const [typed, setTyped] = useState("");
  const [value, setValue] = useState<V>(spec.initial);
  const reg = spec.owner.kind === "registration" ? e.registrations.find((r) => r.id === (spec.owner as { id: string }).id) : undefined;
  const since = (reg ? reg.current?.effective_from : e.current?.effective_from) ?? today;
  const chosen = dateOf(when, typed, today);
  const sched = spec.owner.kind === "entity" ? scheduledFrom(e) : undefined;
  const early = verb === "rev" ? revProblem(chosen, since, sched) : null;
  const earlyText = early === "beforeScheduled" ? t("entityRecord.revise.beforeScheduled", { date: fmtDate(sched!) }) : early ? t("entityRecord.revise.beforeInForce", { date: fmtDate(since) }) : undefined;
  const ready = verb !== null && (verb === "cor" || (chosen !== "" && !early)) && spec.ready(value);
  const save = useCommand({
    run: async (_: undefined, key: string): Promise<unknown> => {
      const owner = spec.owner;
      if (owner.kind === "entity") {
        const body = entityRevision(e, spec.patch(value) as EntityPatch, verb!, chosen);
        if (!body) throw new Error("restricted: the entity cannot be read whole");
        return spec.submit ? spec.submit(key, body) : reviseEntity(key, e.id, body);
      }
      const body = registrationRevision(e, owner.id, spec.patch(value) as RegistrationPatch, verb!, chosen);
      if (!body) throw new Error("unreachable: a certificate without its current state");
      return reviseRegistration(key, owner.id, body);
    },
    invalidates: ENTITY_READS,
    // Closes only once the record is read again: the next sheet opened from it must carry the newest version, or its
    // save is refused as stale (parity S3: a phone correction right after a representative change dead-ended).
    settle: true,
    announce: () => t(verb === "cor" ? "entityRecord.revise.corrected" : "entityRecord.revise.changed", { field: spec.label }),
    onSuccess: onClose,
  });
  const newText = spec.show(value);
  const stale = isStale(save.error);
  const fresh = latest.isSuccess && latest.dataUpdatedAt > save.submittedAt;
  const owner = spec.owner.kind === "entity" ? { kind: "entity" as const, id: e.id } : { kind: "registration" as const, id: spec.owner.id };
  const read = owner.kind === "entity" ? readVersion(e) : (reg?.current?.version ?? 0);
  // A change frame for this record while the sheet is open (an open sheet holds re-reads, so the frame itself is the signal).
  // A frame is only a hint (an earlier save's echo can arrive late): the record is read once, and the notice shows only when
  // it is past the version this sheet holds.
  const [moved, setMoved] = useState<string | null>(null);
  useEffect(
    () =>
      onRecordChange((c) => {
        if (c.id !== owner.id) return;
        void readEntity(opened.id)
          .then((now) => {
            const v = owner.kind === "entity" ? readVersion(now) : (now.registrations.find((r) => r.id === owner.id)?.current?.version ?? 0);
            if (v > read) setMoved(c.at);
          })
          .catch(() => undefined);
      }),
    [owner.id, owner.kind, opened.id, read],
  );
  // the spec (its "now" line and `ready`) stays the one built from the record as opened; rebuild it from
  // `latest` when a conflict on the same field must show that field's newest value in the head too.
  const reapply = () => {
    setE(latest.data!);
    setRebased(true);
    save.reset();
  };
  const consequence = !verb ? (
    <span className={s.lockLine}><Lock size={14} aria-hidden /> {t(spec.corOnly ? "entityRecord.revise.corOnlyFoot" : "entityRecord.revise.initialFoot")}</span>
  ) : (
    <>
      <span>
        {verb === "rev"
          ? chosen ? t("entityRecord.revise.revConsequence", { date: fmtDate(chosen), field: josaLabel(spec.label), value: newText, old: spec.current }) : t("entityRecord.revise.pickDate")
          : spec.empty ? t("entityOps.revise.firstConsequence", { field: spec.label, value: newText })
          : t("entityRecord.revise.corConsequence", { field: spec.label, old: spec.current, value: newText, date: fmtDate(since) })}
      </span>
      {spec.reissue && <Muted>{t("entity.edit.reissue", { count: e.registrations.length })}</Muted>}
      <Muted>{t(phase === "SETUP" ? "entityRecord.revise.setupNote" : "entityRecord.revise.operatingNote")}</Muted>
    </>
  );
  return (
    <Sheet
      open
      onClose={onClose}
      pending={save.isPending}
      wide
      title={t("entityRecord.revise.title", { field: spec.label })}
      subtitle={<><span className={s.kicker}><Building2 size={14} aria-hidden /> {entityName(e)} · {spec.group} · {spec.label}</span>{t("entityRecord.revise.now", { value: spec.current, date: fmtDate(since) })}</>}
      notice={
        <>
          <EntityError error={save.error} historyHref={`/org/entities/${encodeURIComponent(e.id)}?tab=history#history`} own={(code) => (code === "stale_revision" ? t("entityRecord.conflict.alert") : undefined)} />
          {rebased && !save.error && <p className="notice" role="status">{t("entityRecord.conflict.reapplied")}</p>}
        </>
      }
      consequence={consequence}
      actions={
        <>
          <Button onClick={onClose}>{t("entityRecord.cancel")}</Button>
          <Button variant="primary" aria-disabled={!ready || stale || undefined} onClick={() => ready && !stale && save.mutate(undefined)} disabled={save.isPending}>
            {t(spec.empty ? "entityOps.revise.saveFirst" : verb === "rev" ? "entityRecord.revise.saveRev" : verb === "cor" ? "entityRecord.revise.saveCor" : "entityRecord.revise.save")}
          </Button>
        </>
      }
    >
      {spec.empty ? (
        <p className="notice"><Info size={14} aria-hidden /> {t("entityOps.revise.firstEntry", { field: spec.label })}</p>
      ) : spec.corOnly ? (
        <p className="notice"><Info size={14} aria-hidden /> {t("entityRecord.revise.corOnly", { date: fmtDate(since) })}</p>
      ) : (
        <ChoiceField
          label={t("entityRecord.revise.what")}
          required
          options={[
            { value: "rev", label: t("entityRecord.revise.verb.rev", { field: josaLabel(spec.label) }), description: t("entityRecord.revise.verb.revDesc") },
            { value: "cor", label: t("entityRecord.revise.verb.cor"), description: t("entityRecord.revise.verb.corDesc", { date: fmtDate(since) }) },
          ]}
          value={verb}
          onChange={(v) => setVerb(v as Verb)}
        />
      )}
      {verb === "rev" && (
        <div className={s.whenBox}>
          <ChoiceField
            label={t("entityRecord.revise.when")}
            required
            options={[
              { value: "today", label: t("entityRecord.revise.today", { d: mmdd(today) }) },
              { value: "nextMonth", label: t("entityRecord.revise.nextMonth", { d: mmdd(nextMonthFirst(today)) }) },
              { value: "typed", label: t("entityRecord.revise.typed") },
            ]}
            value={when}
            onChange={(v) => setWhen(v as When)}
          />
          {when === "typed" && <DateField label={t("entityRecord.revise.date")} required value={typed} onChange={setTyped} today={today}  error={earlyText} />}
          {when !== "typed" && earlyText && <p className={s.bad} role="alert">{earlyText}</p>}
        </div>
      )}
      {verb && (
        <section className={s.editor} aria-label={t("entityRecord.revise.newValue", { field: spec.label })}>
          <h3 className={s.subhead}>{verb === "rev" && chosen ? t("entityRecord.revise.fromDate", { date: fmtDate(chosen), field: spec.label }) : t("entityRecord.revise.newValue", { field: spec.label })}</h3>
          {spec.edit(value, setValue)}
        </section>
      )}
      {verb === "rev" && chosen && !early && (
        <section aria-labelledby="periods">
          <h3 id="periods" className={s.subhead}>{t("entityRecord.revise.periods")}</h3>
          <ul className={s.periods}>
            {keepsOldPeriod(chosen, since) && <li><span className="num">{t("entityRecord.revise.range", { from: fmtDate(since), to: fmtDate(dayBefore(chosen)) })}</span><span className={s.old}>{spec.current}</span><Chip tone="neutral">{t("entityRecord.revise.nowTag")}</Chip></li>}
            <li><b className="num">{t("entityRecord.revise.openRange", { from: fmtDate(chosen) })}</b><b>{newText}</b>{chosen > today ? <Chip tone="info"><CalendarDays size={12} aria-hidden /> {t("entityRecord.revise.scheduled", { d: mmdd(chosen) })}</Chip> : <Chip tone="ok">{t("entityRecord.revise.fromToday")}</Chip>}</li>
          </ul>
        </section>
      )}
      {stale && <Conflict entityId={e.id} owner={owner} read={read} subject={entityName(e)} mine={newText} fresh={fresh} onReapply={reapply} onDrop={onClose} />}
      {/* worst-case-33 (#27): another tab or person saved this record while the sheet is open; say so before a save meets the
          conflict. Last in the body, so its arrival moves nothing on screen. */}
      {moved && !save.isPending && !save.error && !stale && !rebased && <Banner tone="warn" live="polite">{t("entityRecord.conflict.movedUnder", { time: fmtDateTimeShort(moved) })}</Banner>}
    </Sheet>
  );
}
