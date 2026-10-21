import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { carriesAny, type GroupFacts } from "../domain/facts";

const REF_MAX = 500;

/** Which facts to mark as missing now (after a submit). */
export type ShowFact = (k: "consentRef" | "consentDate" | "severance" | "annualLeave" | "seniority" | "successionRef" | "groupStart") => boolean;

/** The employee's consent: its evidence and its date (Civil Act Art. 657(1)); nothing is recorded without it. */
export function ConsentFields({ v, set, today, show }: { v: GroupFacts; set: (patch: Partial<GroupFacts>) => void; today: string; show: ShowFact }) {
  return (
    <>
      <Field label={t("groupTransfer.consentRef")} required error={show("consentRef") ? t("groupTransfer.consentRef.missing") : undefined}>
        {(p) => <TextInput {...p} maxLength={REF_MAX} value={v.consentRef} onChange={(e) => set({ consentRef: e.target.value })} />}
      </Field>
      <DateField label={t("groupTransfer.consentDate")} required value={v.consentDate} onChange={(consentDate) => set({ consentDate })} today={today} max={today} error={show("consentDate") ? t(v.consentDate ? "groupTransfer.consentDate.after" : "groupTransfer.consentDate.missing") : undefined} />
    </>
  );
}

/**
 * What carries over, dimension by dimension (design T2, spec E5-group-transfer): severance, annual leave and service, each settled or
 * restarted at the sending legal entity or carried by the receiving one, nothing preselected; the succession agreement when any is
 * carried; the group start date kept either way. `date` is the group transfer ("" until picked), `hire` the hire date at the sending
 * legal entity (offered, never filled, as the group start date).
 */
export function ContinuityFields({ v, set, today, show, date, hire }: {
  v: GroupFacts;
  set: (patch: Partial<GroupFacts>) => void;
  today: string;
  show: ShowFact;
  date: string;
  hire?: string;
}) {
  const since = (d: string) => (d ? fmtDate(d) : t("groupTransfer.preview.pick"));
  return (
    <>
      <ChoiceField
        label={t("groupTransfer.severance")}
        required
        options={[
          { value: "SETTLED", label: t("groupTransfer.severance.SETTLED") },
          { value: "CARRIED", label: t("groupTransfer.severance.CARRIED") },
        ]}
        value={v.severance}
        onChange={(c) => set({ severance: c === "CARRIED" ? "CARRIED" : "SETTLED" })}
        error={show("severance") ? t("groupTransfer.severance.missing") : undefined}
      />
      <ChoiceField
        label={t("groupTransfer.annualLeave")}
        required
        options={[
          { value: "SETTLED", label: t("groupTransfer.annualLeave.SETTLED") },
          { value: "CARRIED", label: t("groupTransfer.annualLeave.CARRIED") },
        ]}
        value={v.annualLeave}
        onChange={(c) => set({ annualLeave: c === "CARRIED" ? "CARRIED" : "SETTLED" })}
        error={show("annualLeave") ? t("groupTransfer.annualLeave.missing") : undefined}
      />
      <ChoiceField
        label={t("groupTransfer.seniority")}
        required
        options={[
          { value: "RESTART", label: t("groupTransfer.seniority.RESTART", { date: since(date) }) },
          { value: "CARRIED", label: t("groupTransfer.seniority.CARRIED", { date: since(v.groupStart) }) },
        ]}
        value={v.seniority}
        onChange={(c) => set({ seniority: c === "CARRIED" ? "CARRIED" : "RESTART" })}
        error={show("seniority") ? t("groupTransfer.seniority.missing") : undefined}
      />
      {carriesAny(v) && (
        <Field label={t("groupTransfer.successionRef")} required error={show("successionRef") ? t("groupTransfer.successionRef.missing") : undefined}>
          {(p) => <TextInput {...p} maxLength={REF_MAX} value={v.successionRef} onChange={(e) => set({ successionRef: e.target.value })} />}
        </Field>
      )}
      <DateField
        label={t("groupTransfer.groupStart")}
        required
        value={v.groupStart}
        onChange={(groupStart) => set({ groupStart })}
        today={today}
        presets={hire ? [{ label: t("groupTransfer.groupStart.hire"), date: hire }] : undefined}
        error={show("groupStart") ? t(v.groupStart ? "groupTransfer.groupStart.after" : "groupTransfer.groupStart.missing") : undefined}
      />
    </>
  );
}
