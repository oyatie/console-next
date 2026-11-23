// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { FileSpreadsheet, X } from "lucide-react";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Banner } from "../../../ui/banner/banner";
import { Button, IconButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { StepLine } from "../../../ui/step-line/step-line";
import type { ApplyJob } from "../domain/contract";
import { importError } from "../present";
import { DoneStep } from "./done-step";
import { JobStep } from "./job-step";
import { PreviewStep } from "./preview-step";
import { RecentRuns } from "./recent-runs";
import { UploadStep } from "./upload-step";
import { IMPORT_STEPS, useImportWorkspace } from "./use-import-workspace";

const DryRunStep = lazy(() => chunk(import("./dryrun-step")).then((m) => ({ default: m.DryRunStep })));
const ImportConsole = lazy(() => chunk(import("./import-console")).then((m) => ({ default: m.ImportConsole })));

/**
 * Roster import (BW-10, MR-7, IMPORT-2): upload any layout, check (and if need be set) each sheet's header row and
 * columns, a dry run whose needs-review queue the user settles item by item, then an apply bound to that dry run's
 * digest. The file stays in memory so a remapped sheet, or a run that expired, is read again without choosing it twice.
 */
export function ImportPage() {
  return (
    <AccessGate domain="hr_basic" level="edit" tenant>
      <ExperienceSwitch baseline={() => <ImportWorkspace />}>
        {() => (
          <Suspense fallback={<ReadSkeleton layout="form" />}>
            <ImportConsole />
          </Suspense>
        )}
      </ExperienceSwitch>
    </AccessGate>
  );
}

function ImportWorkspace() {
  const ws = useImportWorkspace();
  const { references, failedName, mode, run, source, mapping, preview, picks, setPicks, dry, setDry, report, jobRun, setJobRun, expired, setExpired, step, at, reread, restart, toSheets, onApplied, onJobFailed, startPreview, closeWorkspace } = ws;

  return (
    <div className="page">
      <PageHead
        titleId="import-title"
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("import.crumb")} />}
        title={t("import.title")}
        tools={
          <>
            <StepLine label={t("import.steps")} steps={IMPORT_STEPS.map((key, i) => ({ key, label: t(`import.step.${key}`), state: i < at || step === "done" ? "done" : i === at ? "current" : "waiting" }))} />
            {source && <Chip><FileSpreadsheet size={14} aria-hidden /> {source.file.name}</Chip>}
            <IconButton label={t("import.close")} onClick={closeWorkspace}><X size={16} aria-hidden /></IconButton>
          </>
        }
      />
      {expired && (
        <Banner tone="danger" live="assertive" actions={<Button variant="primary" disabled={reread.isPending} onClick={() => reread.mutate(mapping)}>{t("import.expired.reread")}</Button>}>
          {t("import.expired")}
        </Banner>
      )}
      <CommandError error={reread.error} own={importError} />
      {step === "upload" && (
        <>
          {references.data === undefined && (
            <DisabledReason
              control={(p) => <Button {...p} variant="primary">{t("uiFileDrop.pick")}</Button>}
              reason={t(queryView(references) === "denied" ? "common.denied.reason" : "import.reference.required")}
            />
          )}
          <QueryState q={references} layout="form" own={() => t("import.reference.failed", { name: failedName })}>
            {() => (
              <>
                <UploadStep paste={mode === "paste"} onPreview={startPreview} />
                <RecentRuns />
              </>
            )}
          </QueryState>
        </>
      )}
      {step === "preview" && preview && picks && (
        <PreviewStep
          preview={preview}
          picks={picks}
          mapping={mapping}
          rereading={reread.isPending}
          onRemap={(m) => reread.mutate(m)}
          onDryRun={setDry}
          onExpired={() => setExpired(true)}
          onRestart={restart}
        />
      )}
      {step === "dryrun" && preview && picks && dry && (
        <Suspense fallback={null}>
          <DryRunStep
            picks={picks}
            onPicks={setPicks}
            dry={dry}
            onDryRun={setDry}
            onApplied={onApplied}
            onJob={(j: ApplyJob) => setJobRun(j.run_id)}
            onExpired={() => setExpired(true)}
            onSheets={toSheets}
            onRestart={restart}
          />
        </Suspense>
      )}
      {step === "job" && jobRun && <JobStep runId={jobRun} onDone={onApplied} onFailed={onJobFailed} />}
      {step === "done" && (run ?? jobRun ?? preview?.run_id) && <DoneStep report={report ?? undefined} runId={(run ?? jobRun ?? preview?.run_id)!} />}
    </div>
  );
}
