import { EnumCode } from "../../../ui/enum-value";
import type { ReactNode, RefObject } from "react";
import { Network } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { LEAVE_TYPE, label } from "../../../lib/labels";
import type { LifecycleEvent } from "../api";
import type { Verb } from "../domain/lifecycle";
import type { JobTitle } from "../domain/titles";
import { fmtDayShort } from "../present";
import { AppointFields, ConvertFields } from "./lifecycle-appoint";
import { LeaveFields } from "./lifecycle-leave";
import { CatalogPicker } from "./catalog-picker";
import { PromoteTarget } from "./lifecycle-promote";
import { RenewalFields } from "./lifecycle-renewal";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { DEMOTION_REASON } from "../domain/titles";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { UnitTarget } from "./transfer-target";
import { useTransferOptions } from "./use-transfer-options";
import type { Draft } from "./use-lifecycle-draft";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];

/**
 * The sheet's "what" section: the target of each kind of act (unit, title or position, leave facts, return, new
 * contract end). A correction keeps the dates a second person must approve (the return date, the contract end).
 */
export function LifecycleWhat({ detail, kind, appointMode, v, set, today, bounds, lastLeave, currentTitle, contractEnd, show, note, correcting, what, dateSlot, tried }: {
  detail: Detail;
  kind: Verb;
  appointMode?: "role" | "job" | "all";
  v: Draft;
  set: (patch: Partial<Draft>) => void;
  today: string;
  bounds: { min?: string; max?: string };
  lastLeave?: LifecycleEvent;
  currentTitle?: JobTitle;
  contractEnd: string | null | undefined;
  show: (k: "unit" | "position" | "leaveType" | "returnDate" | "endDate" | "appoint" | "toType") => boolean;
  note?: ReactNode;
  correcting: boolean;
  what: RefObject<HTMLDivElement | null>;
  /** The effective-date control, for a kind that draws it beside its own dates (a leave's start and return). */
  dateSlot?: ReactNode;
  tried: boolean;
}) {
  const e = detail.employee;
  const transfer = useTransferOptions(e);
  return (
    <section className={s.section} aria-labelledby="lc-what">
      <h3 id="lc-what" className="sr-only">{t("lifecycle.section.what")}</h3>
      <div ref={what} className={s.block}>
        {kind === "TRANSFER" && <UnitTarget label={t("lifecycle.transfer.unit")} icon={<Network size={16} aria-hidden />} {...transfer} value={v.unit} onChange={(unit) => set({ unit })} error={show("unit") ? t("lifecycle.transfer.missing") : undefined} note={note} />}
        {kind === "PROMOTE" && <CatalogPicker kind="GRADE" label={t("empFix.field.grade")} currentId={detail.classification.grade_id} value={v.gradeId || null} onChange={(gradeId) => set({ gradeId })} required={false} />}
        {kind === "PROMOTE" && (
          <PromoteTarget
            employee={e}
            current={currentTitle}
            value={v.position}
            titleId={v.titleId}
            onChange={(position) => set({ position, titleId: "" })}
            onTitle={(x) => set({ titleId: x?.id ?? "", position: x?.label ?? "" })}
            missing={show("position")}
            note={note}
          />
        )}
        {kind === "APPOINT" && <AppointFields mode={appointMode} v={v} set={set} missing={show("appoint")} />}
        {kind === "EMPLOYMENT_TYPE_CHANGE" && (
          <ConvertFields
            current={detail.employment?.employment_type}
            v={v}
            set={set}
            today={today}
            typeError={show("toType") ? t("lifecycle.convert.missing") : undefined}
            endError={show("endDate") ? t("lifecycle.convert.endMissing") : undefined}
            locked={correcting}
          />
        )}
        {kind === "LEAVE_OF_ABSENCE" && (
          <LeaveFields
            start={v.date}
            today={today}
            startSlot={dateSlot}
            tried={tried}
            type={v.leaveType}
            onType={(leaveType) => set({ leaveType })}
            returnDate={v.returnDate}
            onReturn={(returnDate) => set({ returnDate })}
            typeError={show("leaveType") ? t("lifecycle.leave.typeMissing") : undefined}
            returnError={show("returnDate") ? t(v.returnDate ? "lifecycle.leave.returnBeforeStart" : "lifecycle.leave.returnMissing") : undefined}
            locked={correcting}
          />
        )}
        {kind === "RETURN_FROM_LEAVE" && (
          <p className={s.fact}>
            {!lastLeave ? t("lifecycle.return.factUnknown")
              : lastLeave.expected_return_date ? t("lifecycle.return.factPlanned", { from: lastLeave.effective_date, to: lastLeave.expected_return_date, type: lastLeave.leave_type ? label(LEAVE_TYPE, lastLeave.leave_type) : "—", unit: lastLeave.from_org_unit ?? lastLeave.to_org_unit ?? "—" })
              : t("lifecycle.return.fact", { date: fmtDayShort(lastLeave.effective_date), type: lastLeave.leave_type ? label(LEAVE_TYPE, lastLeave.leave_type) : "—" })} <EnumCode e={LEAVE_TYPE} value={lastLeave?.leave_type} />
          </p>
        )}
        {kind === "CONTRACT_RENEWAL" && (
          <RenewalFields
            employeeId={e.id}
            contractEnd={contractEnd}
            start={v.date}
            today={today}
            bounds={bounds}
            end={v.endDate}
            onEnd={(endDate) => set({ endDate })}
            onPeriod={(date, endDate) => set({ date, endDate })}
            error={show("endDate") ? t("lifecycle.renewal.endMissing") : undefined}
            locked={correcting}
          />
        )}
      </div>
    </section>
  );
}

const REASON_MAX = 1000;
type Missing = "reasonCode" | "comment" | "voidCode" | "voidNote";

/**
 * The sheet's "why" section: a transfer's or promotion's reason code (a demotion takes only disciplinary demotion) and the note
 * every record keeps, then the lifecycle_cancel reason of a replaced reservation or a correction (BW-11).
 */
export function LifecycleWhy({ kind, v, set, demotion, replaces, correcting, voidNote, show }: {
  kind: Verb;
  appointMode?: "role" | "job" | "all";
  v: Draft;
  set: (patch: Partial<Draft>) => void;
  demotion: boolean;
  replaces: boolean;
  correcting: boolean;
  voidNote: boolean;
  show: (k: Missing) => boolean;
}) {
  const coded = kind === "TRANSFER" || kind === "PROMOTE";
  return (
      <section className={s.section} aria-labelledby="lc-why">
        <h3 id="lc-why" className="sr-only">{t("lifecycle.section.why")}</h3>
        {coded && (
          <ReasonCodeField
            look="chips"
            domain={kind === "TRANSFER" ? "lifecycle_transfer" : "lifecycle_promote"}
            label={t("lifecycle.reasonCode")}
            value={v.reasonCode}
            onChange={(reasonCode) => set({ reasonCode })}
            only={demotion ? [DEMOTION_REASON] : undefined}
            hint={demotion ? t("lifecycle.promote.demotion") : undefined}
            error={show("reasonCode") ? t(demotion ? "lifecycle.promote.demotionMissing" : "reason.field.missing") : undefined}
          />
        )}
        <Field label={t(coded ? "lifecycle.reason.note" : "lifecycle.reason")} required hint={t("lifecycle.reason.count", { count: v.comment.length, max: REASON_MAX })} error={show("comment") ? t("lifecycle.reason.missing") : undefined}>
          {(p) => <TextArea {...p} maxLength={REASON_MAX} value={v.comment} onChange={(ev) => set({ comment: ev.target.value })} />}
        </Field>
        {(replaces || correcting) && (
          <ReasonCodeField
            domain="lifecycle_cancel"
            label={t(correcting ? "lifecycle.correct.reason" : "lifecycle.replace.reason")}
            value={v.voidCode}
            onChange={(voidCode) => set({ voidCode })}
            noteless={!correcting}
            error={show("voidCode") ? t("reason.field.missing") : undefined}
          />
        )}
        {correcting && voidNote && (
          <Field label={t("lifecycle.correct.note")} required error={show("voidNote") ? t("lifecycle.reason.missing") : undefined}>
            {(p) => <TextArea {...p} maxLength={REASON_MAX} value={v.voidNote} onChange={(ev) => set({ voidNote: ev.target.value })} />}
          </Field>
        )}
      </section>
  );
}
