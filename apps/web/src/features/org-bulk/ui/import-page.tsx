import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { QueryState } from "../../../lib/react/query-state";
import { GateRail } from "../../../ui/gate-rail";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { structureQuery } from "../api";
import { BulkHead } from "./bulk-head";
import { STEPS, useImportWizard } from "./import-parts";
import s from "./bulk.module.css";

const ImportConsole = lazy(() => chunk(import("./import-console")).then((m) => ({ default: m.ImportConsole })));

/** S7 org sheet import: file → columns → values (exact names only) → preview → apply, one undo for the whole import. */
export function ImportPage() {
  return <AccessGate domain="org" level="edit"><ImportWorkspace /></AccessGate>;
}

function ImportWorkspace() {
  return (
    <ExperienceSwitch baseline={() => <ImportBaseline />}>
      {() => <Suspense fallback={<ReadSkeleton layout="form" />}><ImportConsole /></Suspense>}
    </ExperienceSwitch>
  );
}

function ImportBaseline() {
  const tree = useQuery(structureQuery);
  return <div className={s.frame}>
    <BulkHead title={t("orgBulk.import.title")} crumb={t("orgBulk.import.crumb")} />
    <QueryState q={tree} layout="form">{(d) => <ImportWizard ents={d.entities.filter((e) => e.kind === "LEGAL_ENTITY")} operating={d.phase === "OPERATING"} />}</QueryState>
  </div>;
}

function ImportWizard({ ents, operating }: { ents: Node[]; operating: boolean }) {
  const w = useImportWizard({ ents, operating });
  return (
    <>
      <div className={s.head}>
        <GateRail steps={STEPS.map((k) => ({ key: k, label: t(`orgBulk.import.step.${k}`) }))} current={w.step} />
        {w.fileLabel && <div className={s.note}><FileSpreadsheet size={14} aria-hidden /> {w.fileLabel}</div>}
      </div>
      {w.stepBody}
      {w.step !== "apply" && (
        <footer className={s.foot}>
          <output className={s.footText} id="import-foot" data-tone={w.blocked ? "warn" : undefined}>{w.foot}</output>
          {w.noticeView}
          {w.actionsView}
        </footer>
      )}
    </>
  );
}
