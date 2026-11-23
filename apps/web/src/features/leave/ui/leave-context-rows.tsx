// SPDX-License-Identifier: LicenseRef-Proprietary
import { Fragment } from "react";
import { ArrowRight, Users } from "lucide-react";
import { t } from "@console/i18n";
import { FormSection } from "../../../ui/patterns/form-section";
import type { ApprovalPreviewStep } from "../api";
import { formatApprovalStepLabel } from "../present";
import s from "./leave-request-page.module.css";

/** Compact rule-divided team overlap and approval preview rows for `/leave`. */
export function LeaveContextRows({
  overlapError,
  overlapSummary,
  previewError,
  approvalSteps,
}: {
  overlapError: boolean;
  overlapSummary: { names: string; ratio: string } | null;
  previewError: boolean;
  approvalSteps: readonly ApprovalPreviewStep[];
}) {
  return (
    <>
      {(overlapError || overlapSummary) && (
        <FormSection>
          <div className={s.metaRow}>
            <div className={`${s.metaLabel} t-sm t-medium t-ink`}>
              <Users size={15} aria-hidden="true" />
              {t("leave.teamOverlap.label")}
            </div>
            <div className={`${s.metaValue} t-sm muted num`}>
              {overlapError ? (
                t("leave.teamOverlap.unavailable")
              ) : (
                <>
                  <strong className="t-semibold t-ink">{overlapSummary!.names}</strong>{" "}
                  {overlapSummary!.ratio}
                </>
              )}
            </div>
          </div>
        </FormSection>
      )}
      {(previewError || approvalSteps.length > 0) && (
        <FormSection>
          <div className={s.metaRow}>
            <div className={`${s.metaLabel} t-sm t-medium t-ink`}>{t("leave.approval.label")}</div>
            <div className={`${s.metaChain} t-sm muted num`}>
              {previewError
                ? t("leave.approval.unavailable")
                : approvalSteps.map((step, index) => (
                    <Fragment key={`${step.order}-${step.step_kind}`}>
                      {index > 0 && <ArrowRight size={14} aria-hidden="true" />}
                      <strong className="t-semibold t-ink">{formatApprovalStepLabel(step)}</strong>
                    </Fragment>
                  ))}
            </div>
          </div>
        </FormSection>
      )}
    </>
  );
}
