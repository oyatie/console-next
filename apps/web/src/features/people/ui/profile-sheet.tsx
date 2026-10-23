import { MissingEmployment } from "./missing-employment";
import { useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtKrw, fmtNumber } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, label } from "../../../lib/labels";
import { FORMATS, phoneDisplay } from "../../../lib/pure/formats";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { correctEmployee, fileRequest, type ChangeRequest, type Correction, type CorrectionChanges } from "../api";
import { changes, EMPTY, FIELDS, needsSecond, type Current, type Draft, type Field as Key } from "../domain/corrections";
import { Composer } from "../../../ui/composer/composer";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
const REASON_MAX = 100;
const NOTE_MAX = 1000;

export type ProfileDone = { kind: "corrected"; out: Correction } | { kind: "requested"; out: ChangeRequest };

/**
 * Corrects (BW-18) or asks HR to correct (BW-17) an employee's master data: each field shows the
 * record's value and takes only a new one; nothing changes until typed. HR corrects against the version it read;
 * a branch reader files the same changes as a request, or anything else as a written request.
 * the reason is free text up to 100 characters because the server has no reason-code domain for requests
 * and corrections yet (backend ask); it becomes the code field once one is registered.
 */
export function ProfileSheet({ d, mode, onClose, onDone }: { d: Detail; mode: "correct" | "request"; onClose: () => void; onDone: (done: ProfileDone) => void }) {
  const e = d.employee;
  const m = d.employment ?? d.pending_employment;
  const [v, setV] = useState<Draft>(EMPTY);
  const [kind, setKind] = useState<"PROFILE_CORRECTION" | "OTHER" | null>(mode === "correct" ? "PROFILE_CORRECTION" : null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const current: Current = { name: e.name, phone: m?.phone_e164 ?? undefined, hire_date: e.hire_date ?? undefined, employment_type: m?.employment_type ?? undefined, base_pay: m?.base_pay != null ? String(m.base_pay) : undefined };
  const diff = changes(current, v);
  const other = mode === "request" && kind === "OTHER";
  const missing = { kind: !kind, fields: kind === "PROFILE_CORRECTION" && Object.keys(diff).length === 0, reason: !reason.trim(), note: other && !note.trim() };
  const count = Object.values(missing).filter(Boolean).length;
  const run = useCommand({
    run: async (): Promise<ProfileDone> =>
      mode === "correct"
        ? { kind: "corrected", out: await correctEmployee(e.id, e.updated_at, diff as CorrectionChanges, reason.trim(), note.trim()) }
        : { kind: "requested", out: await fileRequest({ kind: kind!, employeeId: e.id, changes: other ? undefined : (diff as CorrectionChanges), reason: reason.trim(), note: note.trim() }) },
    invalidates: ["/api/v1/employees", "/api/v1/change-requests"],
    onSuccess: onDone,
  });
  const set = (patch: Partial<Draft>) => {
    run.reset();
    setV((x) => ({ ...x, ...patch }));
  };
  // A branch reader is not shown phone or pay (the server omits them): said, not shown as empty.
  const hidden = (k: Key) => (k === "phone" || k === "base_pay") && Boolean(m) && m?.base_pay === undefined;
  const was = (k: Key) => {
    const c = current[k];
    if (hidden(k)) return t("people.field.restricted");
    if (!c) return t("person.field.notSet");
    return k === "phone" ? phoneDisplay(c) : k === "hire_date" ? fmtDate(c) : k === "employment_type" ? label(EMPLOYMENT_TYPE, c) : k === "base_pay" ? fmtKrw(c) : c;
  };
  const hint = (k: Key) => t("profile.current", { value: was(k) });
  const consequence =
    mode === "request" ? t("profile.request.consequence", { name: e.name })
    : needsSecond(diff) ? t("profile.correct.consequence.second", { name: e.name })
    : t("profile.correct.consequence", { name: e.name });
  return (
    <Composer
      title={t(mode === "correct" ? "profile.correct.title" : "profile.request.title", { name: e.name })}
      subtitle={[e.employee_number, e.org_unit, e.position].filter(Boolean).join(" · ")}
      onClose={onClose}
      pending={run.isPending}
      notice={run.isError && <CommandError error={run.error} />}
      consequence={<span>{consequence}</span>}
      action={{ kind: "profile", mode: mode === "correct" ? "correct" : "request", count: 1 }}
      tone={"primary"}
      missing={tried ? count : 0}
      onSubmit={() => {
        setTried(true);
        if (count > 0) return false;
        run.mutate(undefined);
      }}
    >
      {mode === "request" && (
        <ChoiceField
          label={t("profile.request.kind")}
          required
          options={[
            { value: "PROFILE_CORRECTION", label: t("profile.request.kind.PROFILE_CORRECTION"), description: t("profile.request.kind.PROFILE_CORRECTION.note") },
            { value: "OTHER", label: t("profile.request.kind.OTHER"), description: t("profile.request.kind.OTHER.note") },
          ]}
          value={kind}
          onChange={(k) => (run.reset(), setKind(k as typeof kind))}
          error={tried && missing.kind ? t("profile.request.kind.missing") : undefined}
        />
      )}
      {kind === "PROFILE_CORRECTION" && (
        <section className={s.section} aria-labelledby="pf-what">
          <h3 id="pf-what" className="sr-only">{t("profile.section.what")}</h3>
          {tried && missing.fields && <p className={s.error} role="alert">{t("profile.fields.missing")}</p>}
          <Field label={t("profile.field.name")} required={false} hint={hint("name")}>
            {(p) => <TextInput {...p} value={v.name} maxLength={100} onChange={(x) => set({ name: x.target.value })} />}
          </Field>
          <DateField label={t("profile.field.hire_date")} required={false} value={v.hire_date} onChange={(hire_date) => set({ hire_date })} today={todayKst()} max={todayKst()} basis={hint("hire_date")} />
          {m && (
            <>
          {/* people-self-60: a field the requester may not read is not offered (no pay change proposed unseen). */}
          {!hidden("phone") && <MaskedField label={t("profile.field.phone")} required={false} format={FORMATS.phone} value={v.phone} onChange={(phone) => set({ phone })} hint={hint("phone")} />}
          <ChoiceField
            label={t("profile.field.employment_type")}
            required={false}
            hint={hint("employment_type")}
            options={EMPLOYMENT_TYPE.values.filter((x) => x !== current.employment_type).map((x) => ({ value: x, label: label(EMPLOYMENT_TYPE, x) }))}
            value={v.employment_type || null}
            onChange={(employment_type) => set({ employment_type })}
            footer={v.employment_type && <Button variant="ghost" onClick={() => set({ employment_type: "" })}>{t("profile.clear")}</Button>}
          />
          {!hidden("base_pay") && (
          <Field label={t("profile.field.base_pay")} required={false} unit={t("profile.won")} hint={hint("base_pay")}>
            {(p) => <TextInput {...p} className="num" inputMode="numeric" value={v.base_pay ? fmtNumber(Number(v.base_pay)) : ""} onChange={(x) => set({ base_pay: x.target.value.replace(/\D/g, "") })} />}
          </Field>
          )}
            </>
          )}
          {!m && <MissingEmployment number={e.employee_number} />}
          {mode === "correct" && needsSecond(diff) && <p className={s.note}>{t("profile.correct.secondNote", { fields: FIELDS.filter((f) => f in diff && f !== "name" && f !== "phone").map((f) => t(`profile.field.${f}`)).join(", ") })}</p>}
        </section>
      )}
      <section className={s.section} aria-labelledby="pf-why">
        <h3 id="pf-why" className="sr-only">{t("lifecycle.section.why")}</h3>
        <Field label={t("profile.reason")} required hint={t("lifecycle.reason.count", { count: reason.length, max: REASON_MAX })} error={tried && missing.reason ? t("lifecycle.reason.missing") : undefined}>
          {(p) => <TextInput {...p} value={reason} maxLength={REASON_MAX} onChange={(x) => (run.reset(), setReason(x.target.value))} />}
        </Field>
        <Field label={t("profile.note")} required={other} hint={t("lifecycle.reason.count", { count: note.length, max: NOTE_MAX })} error={tried && missing.note ? t("profile.note.missing") : undefined}>
          {(p) => <TextArea {...p} value={note} maxLength={NOTE_MAX} onChange={(x) => (run.reset(), setNote(x.target.value))} />}
        </Field>
      </section>
    </Composer>
  );
}
