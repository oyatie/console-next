import { useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { landed } from "../../../lib/react/landed";
import { edit, isConflict, load, rebaseAll, resolve, type Fields } from "../../../lib/pure/three-way";
import { todayKst } from "../../../lib/pure/today";
import { ORG_READS } from "../../../reference/org/api";
import { Composer } from "../../../ui/composer/composer";
import { ConflictPanel } from "../../../ui/conflict/field-conflict";
import { DateField } from "../../../ui/date/date-field";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { changeCommands, refusalOf } from "../api";
import { datePresets } from "../present";
import type { Note } from "./use-note";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
type Key = "effectiveDate" | "reason";

/**
 * Re-dates or re-words a draft, or (`scheduled`, schedule edit org-02) a scheduled change: the same PATCH moves its date or
 * reason, and moved to today it applies at once. The date starts empty (empty keeps it), the reason starts as written. The PATCH
 * takes no version, so a change made elsewhere is caught on refetch and merged per field (concurrent-editing
 * ME-1..ME-5, UX only): untouched fields take the new value and say so, edited ones ask which to keep.
 */
export function DraftEditor({ d, scheduled, refetch, onSaved, onNote, onClose }: {
  d: Detail;
  scheduled?: boolean;
  refetch: () => Promise<{ data?: Detail }>;
  onSaved: () => void;
  onNote: (n: Note) => void;
  onClose: () => void;
}) {
  const today = todayKst();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState(d.reason);
  const [fields, setFields] = useState<Fields<Key>>(() => ({ effectiveDate: load(d.effectiveDate), reason: load(d.reason) }));
  const [seen, setSeen] = useState(d.updatedAt);
  const [taken, setTaken] = useState<Key[]>([]);
  const [error, setError] = useState<{ reason?: string; form?: string }>({});
  if (d.updatedAt !== seen) {
    // Someone saved this draft while it was open: merge, never reset what was typed.
    setSeen(d.updatedAt);
    const r = rebaseAll(fields, { effectiveDate: d.effectiveDate, reason: d.reason });
    setFields(r.fields);
    setTaken((Object.keys(r.outcomes) as Key[]).filter((k) => r.outcomes[k] === "take"));
    if (r.outcomes.reason === "take") setReason(d.reason);
  }
  const conflicts = (Object.keys(fields) as Key[]).filter((k) => isConflict(fields[k]));
  const body = {
    ...(date && date !== d.effectiveDate ? { effectiveDate: date } : {}),
    ...(reason.trim() !== d.reason ? { reason: reason.trim() } : {}),
  };
  const save = useCommand({
    run: () =>
      landed(() => changeCommands(d.id).edit(body), refetch, (x) => (!body.reason || x.reason === body.reason) && (!body.effectiveDate || x.effectiveDate === body.effectiveDate || x.status === "APPLIED")),
    invalidates: ORG_READS,
    onSuccess: () => {
      onSaved();
      onNote({ message: scheduled ? t("orgChange.receipt.rescheduled", { code: d.code, date: fmtDate(body.effectiveDate ?? d.effectiveDate) }) : t("orgChange.receipt.edited", { code: d.code }) });
      onClose();
    },
  });
  const press = () => {
    const e = {
      reason: reason.trim() ? undefined : t("orgChange.reason.required"),
      form: Object.keys(body).length ? undefined : t("orgChange.edit.nothing"),
    };
    setError(e);
    if (!e.reason && !e.form && conflicts.length === 0) save.mutate(undefined);
  };
  const dateError = refusalOf(save.error) === "date" ? t("orgChange.date.min") : undefined;
  const choose = (k: Key, choice: "theirs" | "mine") => {
    setFields((f) => ({ ...f, [k]: resolve(f[k], choice) }));
    if (choice === "theirs" && k === "reason") setReason(String(fields.reason.current));
    if (choice === "theirs" && k === "effectiveDate") setDate("");
  };
  const changedAt = fmtDateTime(d.updatedAt);
  return (
    <Composer title={t(scheduled ? "orgChange.scheduled.edit" : "orgChange.edit")} dirty={Object.keys(body).length > 0} onClose={onClose}
      pending={save.isPending} action={{ kind: "orgChange", mode: "change" }} onSubmit={press}
      blocked={conflicts.length ? { reason: t("uiConflict.left", { count: conflicts.length }) } : undefined}
      consequence={scheduled ? t("orgChange.scheduled.edit.consequence") : undefined}
    ><div className={css.form}>
      {conflicts.length > 0 && (
        <ConflictPanel
          kind="field_conflict"
          choices={{}}
          onChoose={(k, c) => choose(k as Key, c)}
          conflicts={conflicts.map((k) => ({
            field: k,
            label: t(k === "reason" ? "orgChange.reason" : "orgChange.date"),
            base: k === "reason" ? String(fields[k].base) : fmtDate(fields[k].base),
            mine: k === "reason" ? reason : fmtDate(date),
            current: k === "reason" ? String(fields[k].current) : fmtDate(fields[k].current),
            at: changedAt,
          }))}
        />
      )}
      <DateField
        label={t("orgChange.date.new")}
        required={false}
        value={date}
        onChange={(v) => {
          setDate(v);
          setFields((f) => ({ ...f, effectiveDate: edit(f.effectiveDate, v || f.effectiveDate.base) }));
        }}
        today={today}
        min={today}
        basis={t("orgChange.edit.currentDate", { date: fmtDate(d.effectiveDate) })}
        presets={datePresets(today)}
        suggestWeekday
        error={dateError}
      />
      {taken.includes("effectiveDate") && <p className={css.changed}>{t("live.notice.updated_by.hidden", { time: changedAt })}</p>}
      <Field label={t("orgChange.reason")} required error={error.reason}>
        {(p) => (
          <TextArea
            {...p}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setFields((f) => ({ ...f, reason: edit(f.reason, e.target.value.trim()) }));
            }}
          />
        )}
      </Field>
      {taken.includes("reason") && <p className={css.changed}>{t("live.notice.updated_by.hidden", { time: changedAt })}</p>}
      {error.form && <p className="alert" role="alert">{error.form}</p>}
      <CommandError error={refusalOf(save.error) === "date" ? undefined : save.error} />
    </div></Composer>
  );
}
