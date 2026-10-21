import { useState } from "react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { apply, changedRows, dryRun, importCode, lostAnswer, OTHER, readJob, retryAfterOf, timedOut } from "../api";
import type { ApplyJob, ImportDryRun, ImportReport } from "../domain/contract";
import { keepJob } from "../domain/job";

const BUSY_WAIT_MS = 15_000;
import { applyBlockers, deferredCount, reasonsMissing, type Picks } from "../domain/steps";
import { isValueItem } from "../domain/values";
import { importError, outcomeLabel } from "../present";
import { ChangedCells } from "./changed-cells";
import { DryRows } from "./dry-rows";
import { ReviewGroups } from "./review-groups";
import { ReviewQueue } from "./review-queue";
import { ValueTable } from "./value-table";
import { useExpiry } from "./use-expiry";
import s from "./import.module.css";

/**
 * The dry run: the server's plan per row, its counted needs-review queue (each item answered in one click where the
 * server offers the choices, the dry run running again at once), and an apply bound to this dry run's digest (no
 * acknowledgement checkbox: the digest is the acknowledgement, B-14). Apply stays closed while an item blocks.
 */
export function DryRunStep({ picks, onPicks, dry, onDryRun, onApplied, onJob, onExpired, onSheets, onRestart }: {
  picks: Picks;
  onPicks: (c: Picks) => void;
  dry: ImportDryRun;
  onDryRun: (d: ImportDryRun) => void;
  onApplied: (r: ImportReport) => void;
  /** The apply runs as a job (r3:hire-02): the page follows it. */
  onJob: (j: ApplyJob) => void;
  onExpired: () => void;
  onSheets: () => void;
  onRestart: () => void;
}) {
  const [changed, setChanged] = useState(0);
  // One answer open at a time, in the value-link tables or the queue: the chosen one while it is still asked, else the first
  // blocking question (values first, as the page reads), so after each answer the next one is open.
  const [chosen, setChosen] = useState<string | null>(null);
  const asked = [...dry.review.items.filter(isValueItem), ...dry.review.items.filter((i) => !isValueItem(i))];
  const sel = (chosen && (asked.some((i) => i.id === chosen) || /^(remembered|auto):/.test(chosen)) ? chosen : null) ?? (asked.find((i) => i.blocking) ?? asked[0])?.id ?? null;
  const rerun = useCommand({ run: (c: Picks) => dryRun(dry.run_id, c), onSuccess: (d: ImportDryRun) => onDryRun(d) });
  /** An answer from the queue: kept on screen and sent with the next dry run straight away. */
  const resolve = (next: Picks) => (onPicks(next), setChanged(0), rerun.mutate(next));
  const commit = useCommand({
    // Rows changed under the dry run (another writer): nothing was written, so it is computed again and the screen
    // says why; the new digest is what the next apply binds.
    run: async (): Promise<{ report: ImportReport } | { job: ApplyJob } | { changed: number }> => {
      try {
        return await apply(dry.run_id, dry.dry_run_digest);
      } catch (e) {
        // An answer that never came (r3:hire-02): the job may be running. Read the run before offering the apply again.
        if (lostAnswer(e)) {
          const job = await readJob(dry.run_id).catch(() => null);
          if (job && job.dry_run_digest === dry.dry_run_digest) return { job };
        }
        const rows = changedRows(e);
        if (rows === 0) throw e;
        onDryRun(await dryRun(dry.run_id, picks));
        return { changed: rows };
      }
    },
    invalidates: ["/api/v1/employees", "/api/v1/employment-assignments", "/api/v1/onboarding", "/api/v1/org-units", "/api/v1/workplaces"],
    announce: (r) => ("report" in r ? t("import.done.announce", { inserted: r.report.inserted, updated: r.report.updated }) : "job" in r ? t("importJob.started") : t("import.changed", { count: r.changed })),
    onSuccess: (r) => ("report" in r ? onApplied(r.report) : "job" in r ? (keepJob({ runId: dry.run_id, digest: dry.dry_run_digest }), onJob(r.job)) : setChanged(r.changed)),
  });
  useExpiry(rerun.error ?? commit.error, onExpired);

  // A shed apply (503 import_apply_busy, Retry-After) holds the button that long: no second press while the server is full.
  const [hold, setHold] = useState(false);
  const press = () =>
    commit.mutate(undefined, {
      onError: (e) => void (importCode(e) === "import_apply_busy" && (setHold(true), setTimeout(() => setHold(false), retryAfterOf(e) ?? BUSY_WAIT_MS))),
    });
  const block = applyBlockers(dry, picks);
  const missing = reasonsMissing(picks, OTHER);
  const held = deferredCount(dry);
  const reason =
    hold ? t("import.block.busy")
    : block.pending ? t("import.block.pending")
    : block.rows > 0 ? t("import.block.review", { count: block.rows })
    : null;
  const applyLabel = t("import.apply", { insert: dry.insert_candidates, update: dry.update_candidates });
  const stats: [string, number][] = [
    [outcomeLabel("insert"), dry.insert_candidates],
    [outcomeLabel("update"), dry.update_candidates],
    [outcomeLabel("unchanged"), dry.unchanged_rows],
    [outcomeLabel("excluded"), dry.excluded_rows],
    [t("import.stat.review"), dry.review.count],
    [t("import.stat.blocking"), dry.review.blocking],
  ];

  return (
    <>
      <section className="card panel" aria-labelledby="import-dry">
        <h2 id="import-dry" className="panel__title" tabIndex={-1}>{t("import.dry.title")}</h2>
        {changed > 0 && <div className="alert">{t("import.changed", { count: changed })}</div>}
        <div className="stats">
          {stats.map(([k, v]) => (
            <div key={k} className="stat"><span className="stat__label">{k}</span><span className="stat__value num">{fmtNumber(v)}</span></div>
          ))}
        </div>
      </section>
      <ValueTable dry={dry} picks={picks} busy={rerun.isPending} sel={sel} onSel={setChosen} onResolve={resolve} onSheets={onSheets} />
      <ReviewGroups dry={dry} picks={picks} busy={rerun.isPending} onResolve={resolve} />
      <ReviewQueue dry={dry} picks={picks} busy={rerun.isPending} sel={sel} onSel={setChosen} onResolve={resolve} onSheets={onSheets} />
      <ChangedCells dry={dry} />
      <DryRows rows={dry.rows} />
      <section className="card panel form" aria-label={applyLabel}>
        <p className={s.consequence}>{t("import.apply.consequence", { insert: dry.insert_candidates, update: dry.update_candidates, held })}</p>
        {/* What the apply brings in incomplete, named before the press (BE-MIG W02, W03, W12). */}
        {(dry.employment_type_empty_rows > 0 || dry.unplaced.rows > 0 || dry.phone_unstored_rows > 0) && (
          <div className={s.filters} role="group" aria-label={applyLabel}>
            {dry.employment_type_empty_rows > 0 && <Chip tone="warn">{t("import.apply.emptyType", { count: dry.employment_type_empty_rows })}</Chip>}
            {dry.unplaced.rows > 0 && (
              <Chip tone="warn">
                {t("import.apply.unplaced", { count: dry.unplaced.rows })}
                {" · "}
                {Object.entries(dry.unplaced.by_reason).filter(([, n]) => n > 0).map(([k, n]) => `${t(`import.unplaced.${k as "no_place"}`)} ${n}`).join(" · ")}
              </Chip>
            )}
            {dry.phone_unstored_rows > 0 && <Chip tone="neutral">{t("import.apply.phoneUnstored", { count: dry.phone_unstored_rows })}</Chip>}
          </div>
        )}
        {block.pending && <p className="muted" role="status">{t("import.rerun.pending")}</p>}
        <CommandError error={rerun.error ?? commit.error} own={importError}>
          {timedOut(commit.error) && <p>{t("import.timedOut", { rows: dry.candidate_rows })}</p>}
        </CommandError>
        <div className={s.bar}>
          <Button onClick={onRestart}>{t("import.otherFile")}</Button>
          {missing > 0 ? (
            <DisabledReason control={(p) => <Button {...p}>{t("import.rerun")}</Button>} reason={t("import.block.reasons", { count: missing })} />
          ) : (
            <Button variant={block.pending ? "primary" : "secondary"} disabled={rerun.isPending} onClick={() => (setChanged(0), rerun.mutate(picks))}>{t("import.rerun")}</Button>
          )}
          {reason ? (
            <DisabledReason control={(p) => <Button {...p} variant={block.pending ? "secondary" : "primary"}>{applyLabel}</Button>} reason={reason} />
          ) : (
            <Button variant="primary" disabled={commit.isPending || rerun.isPending} onClick={press}>{applyLabel}</Button>
          )}
        </div>
      </section>
    </>
  );
}
