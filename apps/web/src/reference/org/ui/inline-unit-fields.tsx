// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { PopoverButton } from "../../../ui/popover/popover-button";
import type { useInlineUnitValues } from "./use-inline-unit-values";
import { EffectiveDateChip } from "./effective-date-chip";

export function InlineUnitFields({ setup, state, pending, onDraft }: { setup: boolean; state: ReturnType<typeof useInlineUnitValues>; pending: boolean; onDraft: () => void }) {
  return <>
    <EffectiveDateChip setup={setup} today={state.today} value={state.values.effectiveDate} onChange={(effectiveDate) => state.set((v) => ({ ...v, effectiveDate }))} />
    {!setup && <>
      <PopoverButton chip label={t("orgUnit.gov.reason")} title={t("orgUnit.gov.reason")} trigger={t("orgUnit.gov.reason")}>
        {() => <Field label={t("orgUnit.gov.reason")} required>{(p) => <TextArea {...p} rows={2} maxLength={4000} value={state.values.reason} readOnly={pending} onChange={(e) => { const reason = e.target.value; state.set((v) => ({ ...v, reason })); }} />}</Field>}
      </PopoverButton>
      <Button size="sm" variant="ghost" disabled={pending || !state.valid} onClick={onDraft}>{t("composer.saveDraft")}</Button>
    </>}
  </>;
}

