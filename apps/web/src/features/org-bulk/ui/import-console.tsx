// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileSpreadsheet, X } from "lucide-react";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { StepLine } from "../../../ui/step-line/step-line";
import { structureQuery } from "../api";
import { STEPS, useImportWizard } from "./import-parts";
import s from "./bulk.module.css";

export function ImportConsole() {
  const tree = useQuery(structureQuery);
  const ents = (tree.data?.entities ?? []).filter((e) => e.kind === "LEGAL_ENTITY");
  if (!tree.data) {
    return (
      <WizardPattern
        q={tree}
        head={{
          title: t("orgBulk.import.title"),
          crumbs: <Crumbs items={[<Link key="org" to="/org">{t("orgStructure.title")}</Link>]} current={t("orgBulk.import.crumb")} />,
          actions: (
            <Link to="/org" search={{}} className={buttonClass("ghost", { icon: true })} aria-label={t("orgBulk.close")}>
              <X size={16} aria-hidden />
            </Link>
          ),
        }}
        body={null}
        actions={null}
      />
    );
  }
  return <ImportConsoleWizard tree={tree} ents={ents} operating={tree.data.phase === "OPERATING"} />;
}

function ImportConsoleWizard({
  tree,
  ents,
  operating,
}: {
  tree: ReturnType<typeof useQuery<Awaited<ReturnType<typeof structureQuery.queryFn>>>>;
  ents: Node[];
  operating: boolean;
}) {
  const w = useImportWizard({ ents, operating });
  const at = STEPS.indexOf(w.step);
  return (
    <WizardPattern
      q={tree}
      head={{
        title: t("orgBulk.import.title"),
        crumbs: <Crumbs items={[<Link key="org" to="/org">{t("orgStructure.title")}</Link>]} current={t("orgBulk.import.crumb")} />,
        meta: w.fileLabel ? (
          <>
            <FileSpreadsheet size={14} aria-hidden />
            <bdi>{w.fileLabel}</bdi>
          </>
        ) : undefined,
        actions: (
          <Link to="/org" search={{}} className={buttonClass("ghost", { icon: true })} aria-label={t("orgBulk.close")}>
            <X size={16} aria-hidden />
          </Link>
        ),
      }}
      steps={
        <div className={s.stepsWrap}>
          <StepLine
            label={t("orgBulk.import.title")}
            steps={STEPS.map((k, i) => ({
              key: k,
              label: t(`orgBulk.import.step.${k}`),
              state: i < at ? "done" : i === at ? "current" : "waiting",
            }))}
          />
        </div>
      }
      body={w.stepBody}
      notice={w.noticeView}
      consequence={
        w.step !== "apply" ? (
          <bdi className={s.footText} id="import-foot" data-tone={w.blocked ? "warn" : undefined}>
            {w.foot}
          </bdi>
        ) : undefined
      }
      actions={w.actionsView}
    />
  );
}
