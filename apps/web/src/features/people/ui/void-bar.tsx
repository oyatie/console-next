import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { segmentOf } from "../domain/record-spec";
import { voidRecord, type RecordEntry } from "../api/record";
import type { Card } from "./use-card";
import { tx } from "../present";
import { Banner } from "../../../ui/banner/banner";
import s from "./card.module.css";

const REASONS = ["WRONG_PERSON", "DUPLICATE", "NOT_TRUE", "OTHER"] as const;

/**
 * void of one row (E2-records-void): a reason with no default, then the row stays struck in place and its section's
 * history keeps it. The primary stays focusable while the reason is missing and takes focus to it (R9).
 */
export function VoidBar({ c, entry, onDone }: { c: Card; entry: RecordEntry; onDone: () => void }) {
  const [why, setWhy] = useState<string | null>(null);
  const run = useCommand({
    run: (_: undefined, key: string) => voidRecord(c.e.id, segmentOf(entry.section), entry, tx(`empDoc.void.reason.${why}`), key),
    invalidates: ["/api/v1/employees"],
    settle: true,
    onSuccess: onDone,
    announce: () => t("empDoc.void.done"),
  });
  const id = `void-${entry.id}`;
  return (
    <div role="group" aria-label={t("empDoc.void.title")}>
      <Banner tone="warn">
      <ChipChoice id={id} label={t("empDoc.void.why")} options={REASONS.map((r) => ({ value: r, label: t(`empDoc.void.reason.${r}`) }))} value={why} onChange={setWhy} />
      <p className={s.note}>{t("empDoc.void.rule")}</p>
      {run.isError && <CommandError error={run.error} />}
      <div className={s.popActs}>
        <Button variant="ghost" onClick={onDone}>{t("empDoc.void.cancel")}</Button>
        <Button
          variant="primary"
          aria-disabled={!why || undefined}
          onClick={() => (why ? run.mutate(undefined) : document.getElementById(id)?.querySelector<HTMLElement>("input")?.focus())}
        >
          {t("empDoc.void.commit")}
        </Button>
      </div>
      </Banner>
    </div>
  );
}
