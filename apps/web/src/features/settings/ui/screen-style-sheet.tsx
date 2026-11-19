// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { reasonCodesQuery, useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { changeSetting } from "../../../reference/settings/api";
import { experienceChoiceOptions } from "../../../shell/frame/experience-options";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { experienceEditProblem } from "../domain/summaries";

const DOMAIN = "settings_change";
const NOTE_MAX = 1000;

const own = (code: string) => {
  const id = `settingsHub.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

const styleLabel = (code: string) => {
  const id = `settingsHub.code.${code}`;
  return isMessageId(id) ? t(id) : code;
};

export function ScreenStyleSheet({ entry, onClose }: {
  entry: components["schemas"]["SettingEntry"];
  onClose: () => void;
}) {
  const { current, options } = experienceChoiceOptions(entry.value);
  const reasons = useQuery(reasonCodesQuery(DOMAIN));
  const [value, setValue] = useState<string>(current);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const needsNote = useNeedsNote(DOMAIN, reason);
  const problem = experienceEditProblem({ current, next: value, reason, needsNote, note });

  const save = useCommand({
    run: () =>
      changeSetting("display.experience", {
        value,
        reason_code: reason!,
        ...(entry.version != null ? { expected_version: entry.version } : {}),
        ...(needsNote && note.trim() ? { reason_note: note.trim() } : {}),
      }),
    invalidates: ["/api/v1/settings"],
    awaitFirstRead: true,
    announce: () => t("settingsHub.experience.saved", { style: styleLabel(value) }),
    onSuccess: () => onClose(),
  });

  return (
    <Composer
      open
      title={t("settingsHub.experience.sheetTitle")}
      action={{ kind: "screenStyle", mode: "save" }}
      onClose={onClose}
      pending={save.isPending}
      loading={reasons.isPending}
      error={save.error}
      notice={<CommandError error={save.error} own={own} />}
      consequence={t("settingsHub.experience.consequence", { style: styleLabel(value) })}
      dirty={value !== current || reason !== null || (needsNote && note.trim() !== "")}
      blocked={problem ? { reason: t(`settingsHub.experience.problem.${problem}`) } : undefined}
      onSubmit={() => { save.mutate(undefined); }}
    >
      <ChoiceField
        label={t("settingsHub.experience.field")}
        required
        options={options}
        value={value}
        onChange={setValue}
      />
      <ReasonCodeField
        domain={DOMAIN}
        label={t("settingsHub.experience.reason")}
        value={reason}
        onChange={setReason}
      />
      {needsNote && (
        <Field label={t("settingsHub.experience.note")} required>
          {props => <TextArea {...props} value={note} maxLength={NOTE_MAX} onChange={event => setNote(event.target.value)} />}
        </Field>
      )}
    </Composer>
  );
}
