// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { privacyReceipt } from "../api";
import type { WirePrivacyReceipt } from "../api/privacy-intake";
import { PrivacyIntakeWorkbench } from "./privacy-intake-workbench";
import s from "./privacy-intake.module.css";

export function PrivacyIntakeInspector({
  request,
  subjectName,
  asOf,
}: {
  request: WirePrivacyReceipt;
  subjectName: string;
  asOf: string;
}) {
  const summary = privacyReceipt(request, asOf);

  return (
    <div className={s.section}>
      <RecordIdentityBar
        name={subjectName}
        number={t("shellRoutes.pair", { primary: t("account.privacy.number"), secondary: summary.receipt_no })}
        badges={
          <>
            <Chip tone={summary.status.tone}>{summary.status.label}</Chip>
            {summary.clock && <DeadlineChip days={summary.clock.days_left} severity={summary.clock.severity} />}
          </>
        }
        roleLine={summary.controller_label}
      />

      <RecordPaneSection title={t("account.privacy.intake")}>
        <KeyValue
          density="dense"
          items={[
            { key: "kinds", label: t("account.privacy.kinds"), value: summary.kinds.map(k => k.label).join(" · ") },
            { key: "received", label: t("account.privacy.received"), value: fmtDateTime(summary.received_at) },
            {
              key: "due",
              label: t("account.privacy.due"),
              value: summary.clock
                ? fmtDate(summary.clock.due_at)
                : summary.without_delay
                  ? t("account.privacy.withoutDelay")
                  : t("account.privacy.noClock"),
            },
            { key: "detail", label: t("account.privacy.detail"), value: summary.detail || t("account.privacy.noDetail") },
          ]}
        />
      </RecordPaneSection>

      <PrivacyIntakeWorkbench
        request={request}
        headerTrailing={
          <Link
            to="/account/privacy/intake/$id"
            params={{ id: request.id }}
            className={buttonClass("secondary", { size: "sm" })}
          >
            {t("privacy.intake.openWorkbench")}
          </Link>
        }
      />
    </div>
  );
}
