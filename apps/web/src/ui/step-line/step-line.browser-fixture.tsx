// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { loadCatalog, t } from "@console/i18n";
import { StepLine, type Step } from "./step-line";
import "../../app.css";

await loadCatalog("ko");
const IMPORT = ["upload", "preview", "dryrun", "done"] as const;
const STAGES = ["attendance", "calculate", "exceptions", "approval", "payment", "delivery"] as const;
// Which status puts a payroll run at which stage is the payroll feature's rule and its own test; this line takes the states.
const states = new URLSearchParams(location.search).get("states")?.split(",") as Step["state"][] | undefined;
// The line as two callers draw it: the payroll run's six stages in the given states (`?states=`), or the finished import.
createRoot(document.getElementById("root")!).render(states
  ? <StepLine label={t("payroll.stages.title")} steps={STAGES.map((key, n) => ({ key, label: t(`payroll.stage.${key}`), state: states[n]! }))} />
  : <StepLine label={t("import.steps")} steps={IMPORT.map(key => ({ key, label: t(`import.step.${key}`), state: "done" }))} />);
