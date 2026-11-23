// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { readGroup } from "../../../lib/react/query-view";
import { entitiesRef } from "../../../reference/entity/api";
import { rulesQuery } from "../../../reference/identifiers/api";
import { excludeReasonsQuery, preview as upload } from "../api";
import type { ImportDryRun, ImportPreview, ImportReport } from "../domain/contract";
import { keptJob } from "../domain/job";
import { mappingJson, type Mapping } from "../domain/mapping";
import { initialPicks, type Picks } from "../domain/steps";
import type { Source } from "./upload-step";

const route = getRouteApi("/app/people/import");
export const IMPORT_STEPS = ["upload", "preview", "dryrun", "done"] as const;
const AT = { upload: 0, preview: 1, dryrun: 2, job: 2, done: 3 } as const;
const HEADING = { upload: "import-title", preview: "import-sheets", dryrun: "import-dry", job: "import-job", done: "import-done" } as const;

export function useImportWorkspace() {
  const entities = useQuery(entitiesRef);
  const numbers = useQuery(rulesQuery);
  const reasons = useQuery(excludeReasonsQuery);
  const reads = [entities, numbers, reasons];
  const references = readGroup(reads);
  const failed = reads.findIndex((q) => q.error === references.error && q.error != null);
  const labels = [t("import.reference.entities"), t("import.reference.numbers"), t("import.reference.reasons")];
  const { mode, run } = route.useSearch();
  const [source, setSource] = useState<Source | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picks, setPicks] = useState<Picks | null>(null);
  const [dry, setDry] = useState<ImportDryRun | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [jobRun, setJobRun] = useState<string | null>(() => (run ? null : keptJob()?.runId ?? null));
  const [expired, setExpired] = useState(false);
  const step = report || run ? "done" : jobRun ? "job" : dry ? "dryrun" : preview ? "preview" : "upload";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else focusSoon(HEADING[step]);
  }, [step]);

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
  const startPreview = (p: ImportPreview, file: Source) => (setSource(file), setPreview(p), setPicks(initialPicks()));

  return {
    references,
    failedName: labels[failed] ?? "",
    mode,
    run,
    source,
    mapping,
    preview,
    picks,
    setPicks,
    dry,
    setDry,
    report,
    jobRun,
    setJobRun,
    expired,
    setExpired,
    step,
    at: AT[step],
    reread,
    restart,
    toSheets,
    onApplied,
    onJobFailed,
    startPreview,
    closeWorkspace: () => void navigate({ to: "/people", search: {} }),
  };
}
