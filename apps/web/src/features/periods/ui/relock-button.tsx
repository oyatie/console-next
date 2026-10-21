import { Lock } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { LOCK_READS, lockPeriod, type PeriodLock } from "../api";
import { domainText, periodText } from "../present";

/**
 * Locks an unlocked period again before its window ends (decision #8b: early re-lock is one click): a new lock over
 * the same window with the original reason, so the history keeps both.
 */
export function RelockButton({ lock, onLocked }: { lock: PeriodLock; onLocked: (l: PeriodLock) => void }) {
  const run = useCommand({
    run: (_: void, key: string) =>
      lockPeriod({ domain: lock.domain, periodStart: lock.periodStart, periodEnd: lock.periodEnd, reasonCode: lock.reasonCode, reason: lock.reason }, key),
    invalidates: LOCK_READS,
    onSuccess: onLocked,
  });
  return (
    <>
      <Button onClick={() => run.mutate(undefined)} aria-disabled={run.isPending || undefined}>
        <Lock size={16} aria-hidden /> {t("periodLocks.relockNow", { domain: domainText(lock.domain), period: periodText(lock) })}
      </Button>
      <CommandError error={run.error} />
    </>
  );
}
