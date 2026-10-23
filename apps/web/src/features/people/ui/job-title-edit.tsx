import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { updateJobTitle } from "../api";
import type { JobTitle } from "../domain/titles";

export function JobTitleEdit({ entry, onClose }: { entry: JobTitle; onClose: () => void }) {
  const [opened] = useState(entry);
  const [label, setLabel] = useState(entry.label);
  const [rank, setRank] = useState(entry.grade_rank?.toString() ?? "");
  const ranked = entry.kind === "GRADE" || entry.kind === "TITLE";
  const n = rank === "" ? undefined : Number(rank);
  const bad = ranked && ((entry.grade_rank !== null && n === undefined) || (n !== undefined && !Number.isInteger(n)));
  const [tried, setTried] = useState(false);
  const run = useCommand({
    run: () => updateJobTitle(entry.id, { label: label.trim() !== opened.label ? label.trim() : undefined, grade_rank: ranked && (n ?? null) !== opened.grade_rank ? n : undefined }),
    invalidates: ["/api/v1/job-titles", "/api/v1/employees"], settle: true, onSuccess: onClose,
  });
  const missing = !label.trim() || bad;
  const changed = label.trim() !== opened.label || (ranked && (n ?? null) !== opened.grade_rank);
  return <Form aria-label={t("titles.edit.title", { label: entry.label })} noValidate onSubmit={() => { setTried(true); if (!missing) { if (changed) run.mutate(undefined); else onClose(); } }}>
    <Field label={t("titles.col.label")} required error={tried && !label.trim() ? t("titles.label.missing") : undefined}>
      {(p) => <TextInput {...p} value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />}
    </Field>
    {ranked && <Field label={t("titles.col.rank")} required={entry.grade_rank !== null} error={bad ? t("titles.rank.integer") : undefined}>
      {(p) => <TextInput {...p} inputMode="numeric" value={rank} onChange={(e) => setRank(e.target.value)} />}
    </Field>}
    <CommandError error={run.error} />
    <div className="row"><Button variant="ghost" onClick={onClose}>{t("composer.dismiss")}</Button><Button type="submit" variant="primary" aria-disabled={missing || run.isPending || undefined}>{t("titles.edit.commit")}</Button></div>
  </Form>;
}
