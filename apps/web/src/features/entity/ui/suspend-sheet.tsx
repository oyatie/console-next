import { useState } from "react";
import { PauseCircle, PlayCircle } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { ENTITY_READS } from "../api";
import { statusProblems, SUSPEND_REASONS, type StatusDraft } from "../domain/workplace-change";
import { EntityError } from "./entity-error";

const FOOT = "suspend-reason";

/**
 * suspension or resumption of one record (catalog company-07): a workplace or a business registration. suspension asks its start, reason and expected end
 * (optional); resumption asks only its day. The record keeps the status as a dated fact; the filings it opens (suspension filing, social insurance
 * suspension) are not made here, and the people placed there keep their placement.
 */
export function SuspendSheet(p: {
  /** What the record is called, e.g. "Pyeongtaek plant" or 「certificate 000-00-00000」. */
  name: string;
  suspended: boolean;
  /** The current status's start: a resumption cannot precede it. */
  since?: string | null;
  people?: number;
  save: (d: StatusDraft, key: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const today = todayKst();
  const suspend = !p.suspended;
  const [d, setD] = useState<StatusDraft>({ since: "", until: "", reason: null });
  const problems = statusProblems(d, suspend, { today, from: p.since });
  // A typed end the field refused is not "no end": the save waits until it is corrected or cleared.
  const [untilInvalid, setUntilInvalid] = useState(false);
  const ready = Object.keys(problems).length === 0 && !(suspend && untilInvalid);
  const save = useCommand({ run: (_: undefined, key: string) => p.save(d, key), invalidates: ENTITY_READS, settle: true, announce: () => t(suspend ? "entityOps.suspend.done" : "entityOps.resume.done", { name: p.name }), onSuccess: p.onClose });
  const verb = t(suspend ? "entityOps.suspend.action" : "entityOps.resume.action");
  const err = (k: keyof StatusDraft) => (problems[k] && problems[k] !== "required" ? t(`entityOps.status.problem.${problems[k]}`) : undefined);
  return (
    <Sheet
      open
      kicker={<>{suspend ? <PauseCircle size={14} aria-hidden /> : <PlayCircle size={14} aria-hidden />}{p.name}</>}
      title={t(suspend ? "entityOps.suspend.title" : "entityOps.resume.title", { name: p.name })}
      subtitle={t(suspend ? "entityOps.suspend.subtitle" : "entityOps.resume.subtitle")}
      onClose={p.onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={
        ready ? (
          <span>{t(suspend ? "entityOps.suspend.consequence" : "entityOps.resume.consequence", { name: p.name, date: fmtDate(d.since), count: p.people ?? 0 })}</span>
        ) : (
          <span id={FOOT}>{t("entityOps.status.hold")}</span>
        )
      }
      actions={
        <>
          <Button onClick={p.onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? <Button variant="primary" onClick={() => save.mutate(undefined)} disabled={save.isPending}>{verb}</Button> : <Button variant="primary" aria-disabled aria-describedby={FOOT} onClick={() => undefined}>{verb}</Button>}
        </>
      }
    >
      <DateField label={t(suspend ? "entityOps.suspend.since" : "entityOps.resume.since")} required value={d.since} onChange={(v) => setD((x) => ({ ...x, since: v }))} today={today} max={today} min={p.since ?? undefined} minReason={t("entityOps.status.problem.beforeCurrent")} maxReason={t("entityOps.status.problem.future")} error={err("since")} />
      {suspend && (
        <>
          <ChoiceField label={t("entityOps.suspend.reason")} required options={SUSPEND_REASONS.map((r) => ({ value: r, label: t(`entityOps.suspend.reason.${r}`) }))} value={d.reason} onChange={(v) => setD((x) => ({ ...x, reason: v as StatusDraft["reason"] }))} />
          <DateField label={t("entityOps.suspend.until")} required={false} value={d.until} onChange={(v) => setD((x) => ({ ...x, until: v }))} onInvalid={setUntilInvalid} today={today} min={d.since || undefined} minReason={t("entityOps.status.problem.untilBeforeSince")} error={err("until")} />
        </>
      )}
    </Sheet>
  );
}
