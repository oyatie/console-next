import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { FileSpreadsheet, X } from "lucide-react";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Banner } from "../../../ui/banner/banner";
import { Button, IconButton } from "../../../ui/button/button";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { StepLine } from "../../../ui/step-line/step-line";
import { Chip } from "../../../ui/chip";
import { preview as upload } from "../api";
import type { ApplyJob, ImportDryRun, ImportPreview, ImportReport } from "../domain/contract";
import { keptJob } from "../domain/job";
import { mappingJson, type Mapping } from "../domain/mapping";
import { initialPicks, type Picks } from "../domain/steps";
import { importError } from "../present";
import { UploadStep, type Source } from "./upload-step";
import { PreviewStep } from "./preview-step";
import { chunk } from "../../../lib/chunk-guard";
import { DoneStep } from "./done-step";
import { JobStep } from "./job-step";
import { RecentRuns } from "./recent-runs";

const DryRunStep = lazy(() => chunk(import("./dryrun-step")).then(m => ({ default: m.DryRunStep })));

const route = getRouteApi("/app/people/import");
const STEPS = ["upload", "preview", "dryrun", "done"] as const;
const AT = { upload: 0, preview: 1, dryrun: 2, job: 2, done: 3 } as const;
/** Each step's heading: focus lands there when a step replaces the one whose button was pressed. */
const HEADING = { upload: "import-title", preview: "import-sheets", dryrun: "import-dry", job: "import-job", done: "import-done" } as const;

/**
 * Roster import (BW-10, MR-7, IMPORT-2): upload any layout, check (and if need be set) each sheet's header row and
 * columns, a dry run whose needs-review queue the user settles item by item, then an apply bound to that dry run's
 * digest. The file stays in memory so a remapped sheet, or a run that expired, is read again without choosing it twice.
 */
export function ImportPage() {
  return <AccessGate domain="hr_basic" level="edit" tenant><ImportWorkspace /></AccessGate>;
}

function ImportWorkspace() {
  const { mode, run } = route.useSearch();
  const [source, setSource] = useState<Source | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picks, setPicks] = useState<Picks | null>(null);
  const [dry, setDry] = useState<ImportDryRun | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  // The run whose apply runs as a job: started here, or kept from an earlier visit (r3:hire-02, EMP-E12-jobs).
  const [jobRun, setJobRun] = useState<string | null>(() => run ? null : keptJob()?.runId ?? null);
  const [expired, setExpired] = useState(false);
  const step = report || run ? "done" : jobRun ? "job" : dry ? "dryrun" : preview ? "preview" : "upload";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else focusSoon(HEADING[step]);
  }, [step]);

  // Reading the same file again: with the operator's sheet mapping, or after the run expired. Answers already made
  // stay on screen; values the server remembers come back on their own.
  const reread = useCommand({
    run: (m: Mapping) => upload(source!.file, source!.start, source!.end, mappingJson(m)),
    onSuccess: (p: ImportPreview, m) => (setMapping(m), setPreview(p), setDry(null), setExpired(false)),
  });
  const restart = () => (setSource(null), setMapping({}), setPreview(null), setPicks(null), setDry(null), setExpired(false), reread.reset());
  const toSheets = () => setDry(null);
  const navigate = useNavigate();
  const onApplied = useCallback((r: ImportReport) => {
    setReport(r);
    void navigate({ to: "/people/import", search: { run: jobRun ?? preview!.run_id }, replace: true });
  }, [navigate, jobRun, preview]);
  const onJobFailed = useCallback(() => setJobRun(null), []);
  const at = AT[step];
  return (
    <div className="page">
      {/* The workspace head (spec E7): where it is, the steps, the file, and the way out. */}
      <PageHead
        titleId="import-title"
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("import.crumb")} />}
        title={t("import.title")}
        tools={
          <>
            <StepLine label={t("import.steps")} steps={STEPS.map((key, i) => ({ key, label: t(`import.step.${key}`), state: i < at || step === "done" ? "done" : i === at ? "current" : "waiting" }))} />
            {source && <Chip><FileSpreadsheet size={14} aria-hidden /> {source.file.name}</Chip>}
            <IconButton label={t("import.close")} onClick={() => void navigate({ to: "/people", search: {} })}><X size={16} aria-hidden /></IconButton>
          </>
        }
      />
      {expired && (
        <Banner tone="danger" live="assertive" actions={<Button variant="primary" disabled={reread.isPending} onClick={() => reread.mutate(mapping)}>{t("import.expired.reread")}</Button>}>
          {t("import.expired")}
        </Banner>
      )}
      <CommandError error={reread.error} own={importError} />
      {step === "upload" && <UploadStep paste={mode === "paste"} onPreview={(p, file) => (setSource(file), setPreview(p), setPicks(initialPicks()))} />}
      {step === "upload" && <RecentRuns />}
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
        <Suspense fallback={null}><DryRunStep
          picks={picks}
          onPicks={setPicks}
          dry={dry}
          onDryRun={setDry}
          onApplied={onApplied}
          onJob={(j: ApplyJob) => setJobRun(j.run_id)}
          onExpired={() => setExpired(true)}
          onSheets={toSheets}
          onRestart={restart}
        /></Suspense>
      )}
      {step === "job" && jobRun && <JobStep runId={jobRun} onDone={onApplied} onFailed={onJobFailed} />}
      {step === "done" && (run ?? jobRun ?? preview?.run_id) && <DoneStep report={report ?? undefined} runId={(run ?? jobRun ?? preview?.run_id)!} />}
    </div>
  );
}
