// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { loadCatalog, t } from "@console/i18n";
import { runStages } from "../../features/payroll/present";
import { StepLine } from "./step-line";
import "../../app.css";

await loadCatalog("ko");
const IMPORT = ["upload", "preview", "dryrun", "done"] as const;
const run = new URLSearchParams(location.search).get("run") as Parameters<typeof runStages>[0] | null;
// The line as two callers draw it: a payroll run by its status (`?run=`), or the import page once it has finished.
createRoot(document.getElementById("root")!).render(run
  ? <StepLine label={t("payroll.stages.title")} steps={runStages(run).map(step => ({ ...step, label: t(`payroll.stage.${step.key}`) }))} />
  : <StepLine label={t("import.steps")} steps={IMPORT.map(key => ({ key, label: t(`import.step.${key}`), state: "done" }))} />);
