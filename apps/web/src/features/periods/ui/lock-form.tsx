import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { i18n, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { useDirtyEscape } from "../../../lib/react/dirty-escape";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { PERIOD_LOCK_DOMAIN } from "../../../lib/labels";
import { useNeedsNote, useReasonCodesReady } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { useCan } from "../../../reference/authz/ui/use-can";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Banner } from "../../../ui/banner/banner";
import { Button, Form } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { DerivedValue } from "../../../ui/field/derived-value";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { LOCK_READS, failedWith, lockPeriod, locksQuery, strandableChangesQuery, type Domain, type PeriodLock } from "../api";
import { datedWithin, monthWindow, overlapping, recentMonths, shiftedStart, type Window } from "../domain/period";
import { dayText, domainText, monthText, periodText, rangeText } from "../present";
import s from "./period-locks.module.css";

type Form = { domain: Domain | null; mode: "month" | "range"; month: string | null; start: string; end: string; code: string | null; reason: string };
const EMPTY: Form = { domain: null, mode: "month", month: null, start: "", end: "", code: null, reason: "" };
type Key = "domain" | "month" | "start" | "end" | "reason";

/** The field ids the press-time validation focuses, in screen order. */
const fid = (k: Key) => `pl-f-${k}`;
const focusField = (k: Key) => document.getElementById(fid(k))?.querySelector<HTMLElement>("input, select, textarea")?.focus();

/**
 * Lock a payroll or accounting period: by month (derived to its first and last day) or a custom
 * range, with a reason code (BW-07) and its note. Nothing is preselected. Missing input keeps the primary enabled
 * and shows errors on press; one user intent per Idempotency-Key, so a retried press records one lock;
 * an overlap with an active lock is a hard block with its fixes, as the server would refuse it.
 */
export function LockForm({ locks, preset, onLocked, onShowLock, onClose }: { locks: readonly PeriodLock[]; preset?: { domain: Domain; month: string } | null; onLocked: (l: PeriodLock) => void; onShowLock: (id: string) => void; onClose: () => void }) {
  // A month chosen on the calendar (the person's own pick) starts the form there; the reason is still theirs to give.
  const [f, setF] = useState<Form>(preset ? { ...EMPTY, domain: preset.domain, month: preset.month } : EMPTY);
  const [pressed, setPressed] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  // Esc closes the card; with input, the first press only arms. Closing keeps the input (the card is hidden, not unmounted).
  const { ref: escRef, armed } = useDirtyEscape<HTMLDivElement>(Boolean(f.domain || f.month || f.start || f.end || f.code || f.reason.trim()), onClose);
  const today = todayKst();
  const needsNote = useNeedsNote("period_lock", f.code);
  const codes = useReasonCodesReady("period_lock");
  const months = recentMonths(today).map((m) => ({ value: m, label: monthText(m) }));

  const w: Window | null = f.mode === "month" ? (f.month ? monthWindow(f.month) : null) : f.start && f.end && f.end >= f.start ? { periodStart: f.start, periodEnd: f.end } : null;
  const clash = f.domain && w ? overlapping(locks, f.domain, w) : undefined;
  const shift = clash && w ? shiftedStart(w, clash) : null;
  const can = useCan();
  const changes = useQuery({ ...strandableChangesQuery, enabled: can("org_change_read") });
  const stranded = w && changes.data ? datedWithin(changes.data.items, w) : [];

  const errors: Partial<Record<Key, string>> = {};
  if (!f.domain) errors.domain = t("periodLocks.error.choose", { field: t("periodLocks.col.domain") });
  if (f.mode === "month" && !f.month) errors.month = t("periodLocks.error.choose", { field: t("periodLocks.month") });
  if (f.mode === "range" && !f.start) errors.start = t("periodLocks.error.choose", { field: t("periodLocks.start") });
  if (f.mode === "range" && !f.end) errors.end = t("periodLocks.error.choose", { field: t("periodLocks.end") });
  else if (f.mode === "range" && f.start && f.end < f.start) errors.end = t("periodLocks.endBeforeStart");
  // Without the server's list, the note alone is the reason (the server takes either).
  if (codes && !f.code) errors.reason = t("reason.field.missing");
  else if ((needsNote || !codes) && !f.reason.trim()) errors.reason = t("periodLocks.error.write", { field: t("periodLocks.reason.note") });
  const shown = (k: Key) => (pressed || (k === "end" && f.start && f.end) ? errors[k] : undefined);
  const missing = (Object.keys(errors) as Key[]).map((k) => ({ domain: t("periodLocks.col.domain"), month: t("periodLocks.month"), start: t("periodLocks.start"), end: t("periodLocks.end"), reason: t("periodLocks.reason") })[k]);

  const lock = useCommand({
    run: (_: void, key: string) => lockPeriod({ domain: f.domain!, periodStart: w!.periodStart, periodEnd: w!.periodEnd, reasonCode: f.code ?? undefined, reason: f.reason.trim() }, key),
    invalidates: LOCK_READS,
    onSuccess: (l) => {
      setF(EMPTY);
      setPressed(false);
      onLocked(l);
    },
  });
  // A 409 the probe did not claim: refresh the list so the overlap check names the lock (or the generic error stays).
  const refused = failedWith(lock.error, 409);
  const { refetch } = useQuery(locksQuery);
  useEffect(() => {
    if (refused) void refetch();
  }, [refused, refetch]);

  const submit = () => {
    const first = (["domain", "month", "start", "end", "reason"] as const).find((k) => errors[k]);
    if (first) {
      setPressed(true);
      announce(t("periodLocks.errors", { count: Object.keys(errors).length }));
      requestAnimationFrame(() => focusField(first));
      return;
    }
    // The blocked primary is a type="button" DisabledReason; Enter in a field still lands here.
    if (clash) return announce(t("periodLocks.overlap.blocked"));
    lock.mutate(undefined);
  };
  const domain = f.domain ? domainText(f.domain) : "";
  const period = w ? periodText(w) : "";
  const label = f.domain && w ? t("periodLocks.lockOne", { domain, period }) : t("periodLocks.lock");

  return (
    <div ref={escRef}>
      <Form className="form" onSubmit={submit} noValidate>
        <div id={fid("domain")}>
          <ChoiceField label={t("periodLocks.col.domain")} required options={PERIOD_LOCK_DOMAIN.values.map((d) => ({ value: d, label: domainText(d) }))} value={f.domain} onChange={(d) => set({ domain: d as Domain })} error={shown("domain")} />
        </div>
        <ChoiceField
          label={t("periodLocks.mode")}
          required
          options={[{ value: "month", label: t("periodLocks.mode.month") }, { value: "range", label: t("periodLocks.mode.range") }]}
          value={f.mode}
          onChange={(m) => set(m === "range" && f.month ? { mode: "range", start: monthWindow(f.month).periodStart, end: monthWindow(f.month).periodEnd } : { mode: m as Form["mode"] })}
        />
        {f.mode === "month" ? (
          <div className="grid-3">
            <div id={fid("month")}>
              <ChoiceField label={t("periodLocks.month")} required options={months} value={f.month} onChange={(m) => set({ month: m })} error={shown("month")} />
            </div>
            {w && <DerivedValue label={t("periodLocks.col.period")} value={rangeText(w)}  />}
          </div>
        ) : (
          <div className="grid-3">
            <div id={fid("start")}><DateField label={t("periodLocks.start")} required value={f.start} onChange={(v) => set({ start: v })} today={today} error={shown("start")} /></div>
            <div id={fid("end")}><DateField label={t("periodLocks.end")} required value={f.end} onChange={(v) => set({ end: v })} today={today} min={f.start || undefined} error={shown("end")} /></div>
          </div>
        )}
        {clash && w && (
          <Banner
            id="pl-overlap"
            tone="danger"
            actions={
              <>
                {shift && (
                  <Button onClick={() => set({ mode: "range", start: shift, end: w.periodEnd })}>{t("periodLocks.overlap.shift", { date: dayText(shift) })}</Button>
                )}
                <Button variant="ghost" onClick={() => onShowLock(clash.id)}>{t("periodLocks.overlap.open")}</Button>
              </>
            }
          >
            {t("periodLocks.overlap", { domain: domainText(clash.domain), period: periodText(clash), date: fmtDate(clash.lockedAt) })}
          </Banner>
        )}
        {stranded.length > 0 && (
          <Banner tone="warn" title={t("periodLocks.strand", { count: stranded.length })}>
            <ul className={s.codes}>
              {stranded.map((c) => (
                <li key={c.id}>
                  <Link to="/org/changes/$id" params={{ id: c.id }} className="code">{c.code}</Link> <span className="num">{fmtDate(c.effectiveDate)}</span>
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {changes.error && !failedWith(changes.error, 403) && <p className={s.reason}>{t("periodLocks.strand.failed")}</p>}
        <div id={fid("reason")} className="form">
          <ReasonCodeField domain="period_lock" label={t("periodLocks.reason")} value={f.code} onChange={(code) => set({ code })} error={shown("reason") && codes && !f.code ? shown("reason") : undefined} />
          <Field label={t("periodLocks.reason.note")} required={needsNote || !codes} example={t("periodLocks.reason.example")} error={f.code || !codes ? shown("reason") : undefined}>
            {(p) => <TextArea {...p} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />}
          </Field>
        </div>
        <ActionBar
          notice={
            <>
              <CommandError error={clash ? null : lock.error} />
              {armed && <p className={s.reason} role="status">{t("periodLocks.escArmed")}</p>}
            </>
          }
          consequence={
            <>
              {f.domain && w && <p className={s.consequence}>{t("periodLocks.lock.consequence", { domain, period })}</p>}
              {missing.length > 0 && <p className={s.reason}>{t("periodLocks.missing", { fields: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(missing) })}</p>}
            </>
          }
          actions={
          clash ? (
            <DisabledReason
              reason={t("periodLocks.overlap.blocked")}
              control={(p) => (
                <Button {...p} variant="primary">
                  <Lock size={16} aria-hidden /> {label}
                </Button>
              )}
            />
          ) : (
            <Button type="submit" variant="primary" disabled={lock.isPending}>
              <Lock size={16} aria-hidden /> {label}
            </Button>
          )
          }
        />
      </Form>
    </div>
  );
}
