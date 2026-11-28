// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import { DateInput } from "../../../ui/date/date-input";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { changeLifecycleHold, lifecyclePath, transitionLifecycle, type Lifecycle } from "../api";
import { lifecycleCode } from "../present";

type Edit = { mode: "transition"; next: string; reason: string } |
  { mode: "hold"; hold: boolean; until: string; revision: string };

export function LifecycleActions({ record }: { record: Lifecycle }) {
  const [edit, setEdit] = useState<Edit>();
  const [tried, setTried] = useState(false);
  const [invalidDate, setInvalidDate] = useState(false);
  const next = record.availableTransitions ?? [];
  const target = { objectType: record.objectType, objectId: record.objectId };
  const change = useCommand({
    run: (draft: Edit, key) => draft.mode === "transition"
      ? transitionLifecycle(target, { toState: draft.next, reason: draft.reason.trim() }, key)
      : changeLifecycleHold(target, { legalHold: draft.hold, retentionUntil: draft.until || undefined, expectedUpdatedAt: draft.revision }, key),
    invalidates: [lifecyclePath, "/api/audit"], settle: true,
    announce: () => t("audit.lifecycle.saved"), onSuccess: () => setEdit(undefined),
  });
  function open(draft: Edit) {
    change.reset(); setTried(false); setInvalidDate(false); setEdit(draft);
  }
  function openHold() {
    open({ mode: "hold", hold: record.legalHold, until: record.retentionUntil ?? "", revision: record.updatedAt });
  }
  const stale = edit?.mode === "hold" && record.updatedAt !== edit.revision;
  function submit() {
    setTried(true);
    if (!edit || stale || change.isPending) return false;
    if (edit.mode === "transition" && (!next.includes(edit.next) || !edit.reason.trim())) return false;
    if (edit.mode === "hold" && invalidDate) return false;
    change.mutate(edit);
  }
  return <>
    {!edit && <>
      {next.length > 0 && <Button onClick={() => open({ mode: "transition", next: "", reason: "" })}>{t("audit.lifecycle.change")}</Button>}
      <Button onClick={openHold}>{t("audit.lifecycle.editHold")}</Button>
    </>}
    {edit && <Composer layout="inline" headingLevel={3} title={t(edit.mode === "hold" ? "audit.lifecycle.editHold" : "audit.lifecycle.change")}
      action={{ kind: edit.mode === "hold" ? "objectRetention" : "objectTransition", mode: "change" }}
      pending={change.isPending} locked={stale} error={change.error} onClose={() => setEdit(undefined)} onSubmit={submit}>
      {edit.mode === "transition" ? <>
        <Field label={t("audit.lifecycle.next")} required>{props => <SelectInput {...props} value={edit.next} onChange={e => setEdit({ ...edit, next: e.target.value })}>
          <option value="">{t("audit.lifecycle.choose")}</option>
          {next.map(state => <option key={state} value={state}>{lifecycleCode(state)}</option>)}</SelectInput>}</Field>
        <Field label={t("audit.lifecycle.reason")} required error={tried && !edit.reason.trim() ? t("audit.lifecycle.required") : undefined}>{props =>
          <TextInput {...props} value={edit.reason} onChange={e => setEdit({ ...edit, reason: e.target.value })} />}</Field>
      </> : <>
        <Field label={t("audit.lifecycle.hold")} required>{props => <SelectInput {...props} value={edit.hold ? "held" : "clear"}
          onChange={e => setEdit({ ...edit, hold: e.target.value === "held" })}>
          <option value="held">{t("audit.lifecycle.held")}</option><option value="clear">{t("audit.lifecycle.clear")}</option>
        </SelectInput>}</Field>
        <Field label={t("audit.lifecycle.retention")} required={false}>{props => <DateInput {...props}
          label={t("audit.lifecycle.retention")} value={edit.until} onChange={until => setEdit({ ...edit, until })} onInvalid={setInvalidDate} />}</Field>
      </>}
    </Composer>}
    {stale && <Button onClick={openHold}>{t("audit.lifecycle.refreshHold")}</Button>}
    {change.error && <CommandError error={change.error} />}
    {change.isSuccess && <p role="status">{t("audit.lifecycle.saved")}</p>}
  </>;
}
