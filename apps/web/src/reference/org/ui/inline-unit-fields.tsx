// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { focusOnce } from "../../../lib/react/focus-once";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { PopoverButton } from "../../../ui/popover/popover-button";
import type { useInlineUnitValues } from "./use-inline-unit-values";
import { EffectiveDateChip } from "./effective-date-chip";

export function InlineUnitFields({ setup, state, pending, onDraft }: { setup: boolean; state: ReturnType<typeof useInlineUnitValues>; pending: boolean; onDraft: () => void }) {
  const reasonState = state.values.reason.trim() ? t("orgUnit.gov.reasonFilled") : state.required ? t("orgUnit.gov.reasonRequired") : t(state.code === "NEW" ? "orgUnit.gov.reasonNew" : "orgUnit.gov.reasonReorg");
  const reasonLabel = `${t("orgUnit.gov.reason")} · ${reasonState}`;
  return <>
    <EffectiveDateChip setup={setup} today={state.today} value={state.values.effectiveDate} onChange={(effectiveDate) => state.set((v) => ({ ...v, effectiveDate }))} />
    {!setup && <>
      <PopoverButton chip label={reasonLabel} title={t("orgUnit.gov.reason")} trigger={reasonLabel} isOpen={state.reasonOpen} onOpenChange={state.setReasonOpen}>
        {() => <Field label={t("orgUnit.gov.note")} required={state.required}>{(p) => <TextArea {...p} ref={focusOnce} rows={2} maxLength={4000} value={state.values.reason} readOnly={pending} onChange={(e) => { const reason = e.target.value; state.set((v) => ({ ...v, reason })); }} />}</Field>}
      </PopoverButton>
      <Button aria-description={state.missingReason ? t("orgUnit.gov.reasonForApproval") : undefined} size="sm" variant="ghost" disabled={pending || !state.valid} onClick={onDraft}>{t("composer.saveDraft")}</Button>
    </>}
  </>;
}

