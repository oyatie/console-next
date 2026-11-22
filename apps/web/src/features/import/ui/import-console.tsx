// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileSpreadsheet, X } from "lucide-react";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import { Banner } from "../../../ui/banner/banner";
import { Button, IconButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { WorklistPadded } from "../../../ui/patterns/worklist-parts";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { StepLine } from "../../../ui/step-line/step-line";
import type { ApplyJob } from "../domain/contract";
import { importError } from "../present";
import { DoneStep } from "./done-step";
import type { DryRunConsoleParts } from "./dryrun-step";
import { ImportConsoleInspector } from "./import-console-inspector";
import { JobStep } from "./job-step";
import { PreviewStep, type PreviewConsoleParts } from "./preview-step";
import { RecentRuns } from "./recent-runs";
import { UploadStep } from "./upload-step";
import { IMPORT_STEPS, useImportWorkspace } from "./use-import-workspace";
import s from "./import-console.module.css";

const DryRunStep = lazy(() => chunk(import("./dryrun-step")).then((m) => ({ default: m.DryRunStep })));
const READY_SHELL: ReadState = { isPending: false, error: null, data: true, refetch: () => Promise.resolve() };

export function ImportConsole() {
  const ws = useImportWorkspace();
  const { references, failedName, mode, run, source, mapping, preview, picks, setPicks, dry, setDry, report, jobRun, setJobRun, expired, setExpired, step, at, reread, restart, toSheets, onApplied, onJobFailed, startPreview, closeWorkspace } = ws;

  const renderWizard = ({ body, aside, asideLabel, consequence, notice, actions, stickyActions = true }: {
    body: ReactNode; aside?: ReactNode; asideLabel?: string; consequence?: ReactNode; notice?: ReactNode; actions: ReactNode; stickyActions?: boolean;
  }) => (
    <WizardPattern
      q={READY_SHELL}
      head={{
        titleId: "import-title",
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("import.crumb")} />,
        title: t("import.title"),
        tools: (
          <>
            {source && <Chip><FileSpreadsheet size={14} aria-hidden /> {source.file.name}</Chip>}
            <IconButton label={t("import.close")} onClick={closeWorkspace}><X size={16} aria-hidden /></IconButton>
          </>
        ),
      }}
      steps={<StepLine label={t("import.steps")} steps={IMPORT_STEPS.map((key, i) => ({ key, label: t(`import.step.${key}`), state: i < at || step === "done" ? "done" : i === at ? "current" : "waiting" }))} />}
      notes={
        <>
          {expired && (
            <Banner tone="danger" live="assertive" actions={<Button variant="primary" disabled={reread.isPending} onClick={() => reread.mutate(mapping)}>{t("import.expired.reread")}</Button>}>
              {t("import.expired")}
            </Banner>
          )}
          {step !== "preview" && <CommandError error={reread.error} own={importError} />}
        </>
      }
      body={<WorklistPadded><div className={s.stack}>{body}</div></WorklistPadded>}
      aside={aside ? <WorklistPadded><div className={s.stack}>{aside}</div></WorklistPadded> : undefined}
      asideLabel={asideLabel}
      consequence={consequence}
      notice={notice}
      actions={actions}
      stickyActions={stickyActions}
    />
  );

  if (step === "preview" && preview && picks) {
    return (
      <PreviewStep
        preview={preview}
        picks={picks}
        mapping={mapping}
        rereading={reread.isPending}
        remapError={reread.error}
        onRemap={(m) => reread.mutate(m)}
        onDryRun={setDry}
        onExpired={() => setExpired(true)}
        onRestart={restart}
        consoleShell={(parts: PreviewConsoleParts) =>
          renderWizard({ body: parts.body, aside: parts.aside, asideLabel: t("import.columns"), notice: parts.notice, actions: parts.actions })
        }
      />
    );
  }

  if (step === "dryrun" && preview && picks && dry) {
    return (
      <Suspense fallback={<ReadSkeleton layout="form" />}>
        <DryRunStep
          picks={picks}
          onPicks={setPicks}
          dry={dry}
          preview={preview}
          onDryRun={setDry}
          onApplied={onApplied}
          onJob={(j: ApplyJob) => setJobRun(j.run_id)}
          onExpired={() => setExpired(true)}
          onSheets={toSheets}
          onRestart={restart}
          consoleShell={(parts: DryRunConsoleParts) =>
            renderWizard({
              body: <><div className={s.triageSticky}>{parts.summary}</div>{parts.body}</>,
              aside: <ImportConsoleInspector dry={dry} picks={picks} currentItem={parts.currentItem} activeRow={parts.activeRow} sexMapped={parts.sexMapped} busy={parts.resolveBusy} onResolve={parts.onResolve} onSheets={parts.onSheets} />,
              asideLabel: t("import.dry.inspector"),
              consequence: parts.consequence,
              notice: <>{parts.changed > 0 && <Banner tone="warn">{t("import.changed", { count: parts.changed })}</Banner>}{parts.notice}</>,
              actions: parts.actions,
            })
          }
        />
      </Suspense>
    );
  }

  if (step === "job" && jobRun) {
    return renderWizard({ body: <JobStep runId={jobRun} onDone={onApplied} onFailed={onJobFailed} />, actions: <Link to="/people" search={{}} className={buttonClass("secondary")}>{t("importJob.toRoster")}</Link>, stickyActions: false });
  }

  if (step === "done" && (run ?? jobRun ?? preview?.run_id)) {
    return renderWizard({
      body: <DoneStep report={report ?? undefined} runId={(run ?? jobRun ?? preview?.run_id)!} />,
      aside: (
        <Card titleId="import-done-aside" title={t("import.done.actions")}>
          <WorklistPadded>
            <div className={s.guide}>
              <Link to="/people/data-health" className={buttonClass("secondary")}>{t("import.gaps.dataHealth")}</Link>
              <Link to="/people/unplaced" className={buttonClass("ghost")}>{t("unplaced.title")}</Link>
            </div>
          </WorklistPadded>
        </Card>
      ),
      asideLabel: t("import.done.actions"),
      actions: (
        <>
          <Link to="/people/import" search={{}} className={buttonClass("secondary")} reloadDocument>{t("import.again")}</Link>
          <Link to="/people" search={{}} className={buttonClass("primary")}>{t("import.viewEmployees")}</Link>
        </>
      ),
      stickyActions: false,
    });
  }

  return renderWizard({
    body: (
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
    ),
    aside: (
      <Card titleId="import-aside-guide" title={t("import.aside.guide")}>
        <WorklistPadded>
          <div className={s.guide}>
            <ul className={s.guideList}>
              <li>{t("import.aside.restrictedRule")}</li>
              <li>{t("import.aside.dateRule")}</li>
            </ul>
            <Link to="/people/data-health" className={buttonClass("secondary")}>{t("import.aside.healthLink")}</Link>
          </div>
        </WorklistPadded>
      </Card>
    ),
    asideLabel: t("import.aside.guide"),
    actions: <Link to="/people" search={{}} className={buttonClass("secondary")}>{t("importJob.toRoster")}</Link>,
    stickyActions: false,
  });
}
