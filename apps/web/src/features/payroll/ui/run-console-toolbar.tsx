// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { AlertTriangle, CheckSquare, CreditCard, Download, FileText } from "lucide-react";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { PeriodStepper } from "../../../ui/period-stepper/period-stepper";
import {
  RegisterNowrap,
  RegisterToolbarSearch,
  RegisterToolbarSelect,
} from "../../../ui/patterns/register-totals-parts";
import { WorklistSearchField, WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import type { RegisterFilterMode } from "../domain/run-register";

type PayrollSideTab = "preflight" | "exceptions" | "delivery";

export function RunConsoleFilters({
  activePeriod,
  setPeriodOverride,
  entities,
  activeEntityId,
  setEntityOverride,
  filter,
  handleFilterChange,
  runHeadcount,
  hasBankIssues,
  attentionCount,
  findQuery,
  handleFindChange,
  setComposing,
}: {
  activePeriod: string;
  setPeriodOverride: (value: string | undefined) => void;
  entities: readonly { id: string; name?: string | null }[];
  activeEntityId: string;
  setEntityOverride: (value: string | undefined) => void;
  filter: RegisterFilterMode;
  handleFilterChange: (next: RegisterFilterMode) => void;
  runHeadcount: number;
  hasBankIssues: boolean;
  attentionCount: number;
  findQuery: string;
  handleFindChange: (value: string) => void;
  setComposing: (composing: boolean) => void;
}) {
  return (
    <>
      <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={activePeriod} onChange={setPeriodOverride} />
      {entities.length > 0 && (
        <RegisterToolbarSelect
          label={t("payroll.entity")}
          value={activeEntityId}
          onChange={setEntityOverride}
          options={entities.map(entity => ({ value: entity.id, label: entity.name ?? t("payroll.entityUnnamed") }))}
        />
      )}
      <WorklistSegmentBar
        label={t("payroll.run.filterLabel")}
        value={filter}
        onChange={handleFilterChange}
        items={[
          { id: "all", label: t("home.inbox.filter.all"), count: fmtNumber(runHeadcount) },
          {
            id: "attention",
            label: hasBankIssues ? t("payroll.run.missingBankFilter") : t("payroll.run.attentionFilter"),
            count: fmtNumber(attentionCount),
            tone: attentionCount > 0 ? "danger" : undefined,
            icon: attentionCount > 0 ? <AlertTriangle size={12} aria-hidden="true" /> : undefined,
          },
        ]}
      />
      <RegisterToolbarSearch>
        <WorklistSearchField
          label={t("payroll.run.findPlaceholder")}
          value={findQuery}
          onChange={handleFindChange}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={e => {
            setComposing(false);
            handleFindChange(e.currentTarget.value);
          }}
        />
      </RegisterToolbarSearch>
    </>
  );
}

export function RunConsoleTools({
  sideTab,
  onToggleSideTab,
  showStatutoryLink,
  onOpenExport,
  showPreview,
  onTogglePreview,
}: {
  sideTab: PayrollSideTab | null;
  onToggleSideTab: (tab: PayrollSideTab) => void;
  showStatutoryLink: boolean;
  onOpenExport: () => void;
  showPreview: boolean;
  onTogglePreview: () => void;
}) {
  return (
    <>
      <Button size="sm" aria-pressed={sideTab === "preflight"} onClick={() => onToggleSideTab("preflight")}>
        <CheckSquare size={13} aria-hidden="true" />
        <RegisterNowrap>{t("payrollRun.tool.preflight")}</RegisterNowrap>
      </Button>
      <Button size="sm" aria-pressed={sideTab === "exceptions"} onClick={() => onToggleSideTab("exceptions")}>
        <AlertTriangle size={13} aria-hidden="true" />
        <RegisterNowrap>{t("payrollRun.tool.exceptions")}</RegisterNowrap>
      </Button>
      <Button size="sm" aria-pressed={sideTab === "delivery"} onClick={() => onToggleSideTab("delivery")}>
        <CreditCard size={13} aria-hidden="true" />
        <RegisterNowrap>{t("payrollRun.tool.delivery")}</RegisterNowrap>
      </Button>
      {showStatutoryLink && (
        <Link to="/statutory" className={buttonClass("secondary", { size: "sm" })}>
          <RegisterNowrap>{t("payrollRun.tool.statutory")}</RegisterNowrap>
        </Link>
      )}
      <Button size="sm" onClick={onOpenExport}>
        <Download size={13} aria-hidden="true" />
        <RegisterNowrap>{t("payroll.run.export")}</RegisterNowrap>
      </Button>
      <Button size="sm" aria-pressed={showPreview} onClick={onTogglePreview}>
        <FileText size={13} aria-hidden="true" />
        <RegisterNowrap>{t("payroll.run.previewToggle")}</RegisterNowrap>
      </Button>
    </>
  );
}
