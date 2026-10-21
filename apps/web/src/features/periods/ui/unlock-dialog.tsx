import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { Dialog } from "../../../ui/dialog";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button, Form } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { addDays } from "../../../ui/date/days";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { LOCK_READS, settingsQuery, unlockPeriod, type PeriodLock, type UnlockOutcome } from "../api";
import { lastUnlockDay, relockAt } from "../domain/period";
import { dayText, domainText, periodText } from "../present";
import s from "./period-locks.module.css";

const NOTE_MAX = 1000;
/** The server's own bound when the settings read is unavailable (period_lock.unlock_max_days default). */
const FALLBACK_MAX_DAYS = 7;

/**
 * Unlock one lock for a time box (BW-15): a reason code and its note, the last day the period stays open (it locks
 * again on its own after it, never later than the setting allows), then the user's passkey bound to exactly this
 * unlock. With another close authority the unlock waits for them; a sole holder's unlocks at once, flagged for review.
 */
export function UnlockDialog({ lock, onClose, onDone }: { lock: PeriodLock | null; onClose: () => void; onDone: (l: PeriodLock, out: UnlockOutcome) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");
  const [pressed, setPressed] = useState(false);
  const today = todayKst();
  const settings = useQuery({ ...settingsQuery, enabled: lock !== null });
  const max = Number(settings.data?.items.find((x) => x.key === "period_lock.unlock_max_days")?.value ?? FALLBACK_MAX_DAYS);
  const last = lastUnlockDay(today, max);
  const needsNote = useNeedsNote("period_unlock", code);
  const missing = { code: !code, note: needsNote && !note.trim(), until: !until || until < today || until > last };
  const reset = () => {
    setCode(null);
    setNote("");
    setUntil("");
    setPressed(false);
  };
  const unlock = useCommand({
    run: (_: void, key: string) => unlockPeriod(lock!.id, { reasonCode: code!, note: note.trim(), relockAt: relockAt(until) }, key),
    invalidates: LOCK_READS,
    onSuccess: (out) => {
      reset();
      onDone(lock!, out);
    },
  });
  const close = () => {
    reset();
    unlock.reset();
    onClose();
  };
  const dirty = Boolean(code || note.trim() || until);
  const title = lock ? t("periodLocks.unlockOne", { domain: domainText(lock.domain), period: periodText(lock) }) : "";
  // Decision #8b: 1 / 3 / 7 days, nothing preselected, never past the setting's maximum.
  const presets = [...new Set([1, 3, 7].map((n) => Math.min(n, max)))].map((n) => ({ label: t("periodLocks.unlock.days", { days: n }), date: addDays(today, n - 1) }));
  const cancelled = unlock.error instanceof Error && unlock.error.message === "passkey_cancelled";
  return (
    <Dialog open={lock !== null} title={title} onClose={close} dismissable={!dirty && !unlock.isPending}>
      {lock && (
        <Form
          className="form"
          noValidate
          onSubmit={() => {
            setPressed(true);
            if (!Object.values(missing).some(Boolean)) unlock.mutate(undefined);
          }}
        >
          <p className={s.consequence}>{t("periodLocks.unlock.window", { domain: domainText(lock.domain), period: periodText(lock) })}</p>
          <ReasonCodeField domain="period_unlock" label={t("periodLocks.unlock.reason")} value={code} onChange={setCode} error={pressed && missing.code ? t("reason.field.missing") : undefined} />
          <Field label={t("periodLocks.unlock.note")} required={needsNote} hint={t("periodLocks.unlock.noteCount", { count: note.length, max: NOTE_MAX })} error={pressed && missing.note ? t("periodLocks.unlock.noteMissing") : undefined}>
            {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <DateField
            label={t("periodLocks.unlock.until")}
            required
            value={until}
            onChange={setUntil}
            today={today}
            min={today}
            max={last}
            basis={t("periodLocks.unlock.untilBasis", { days: max })}
            presets={presets}
            error={pressed && !until ? t("periodLocks.unlock.untilMissing") : undefined}
          />
          <ActionBar
            notice={cancelled ? <p className={s.reason} role="alert">{t("periodLocks.unlock.passkeyCancelled")}</p> : <CommandError error={unlock.error} />}
            consequence={
              <>
                {until && until >= today && until <= last && <p className={s.consequence}>{t("periodLocks.unlock.relock", { date: dayText(addDays(until, 1)) })}</p>}
                <p className={s.reason}>{t("periodLocks.unlock.passkey")}</p>
              </>
            }
            actions={
              <>
                <Button onClick={close} disabled={unlock.isPending}>{t("common.back")}</Button>
                <Button type="submit" variant="danger" aria-disabled={unlock.isPending || undefined}>{t("periodLocks.unlock.commit")}</Button>
              </>
            }
          />
        </Form>
      )}
    </Dialog>
  );
}
