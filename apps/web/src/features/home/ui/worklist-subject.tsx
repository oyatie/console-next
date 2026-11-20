// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { INSURER, LIFECYCLE_EVENT, codeText, label } from "../../../lib/labels";
import { reasonLabel } from "../../../lib/reason-codes";
import { domainText, periodText } from "../../../reference/periods/present";
import { WorklistSubject } from "../../../ui/patterns/worklist-parts";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import s from "./worklist-console.module.css";

export function CompactSubject({ item }: { item: AttentionInboxItem }) {
  const { unlock, insurance, lifecycle, request, correction } = item.context ?? {};
  const primary =
    item.kind === "privacy_request"
      ? (item.context?.privacy_kinds ?? [])
          .map(code => codeText(`account.privacy.kind.${code}`, t("enum.unknown")))
          .join(" · ")
      : unlock
        ? `${domainText(unlock.domain)} ${periodText(unlock)}`
        : request
          ? codeText(`requests.kind.${request.kind}`, t("requests.kind.OTHER"))
          : item.title;

  const facts = correction
    ? [t(`entityRecord.corrections.status.${correction.status}`), item.who]
    : unlock
      ? [
          unlock.requester,
          reasonLabel("period_unlock", unlock.reason_code, unlock.reason_entry ?? undefined),
        ]
      : insurance
        ? [
            label(INSURER, insurance.insurer),
            codeText(`statutory.${insurance.kind}`, t("home.inbox.unknown")),
            fmtDate(insurance.effective_date),
          ]
        : lifecycle
          ? [label(LIFECYCLE_EVENT, lifecycle.action_kind), fmtDate(lifecycle.effective_date)]
          : [];

  const meta = [
    ...facts,
    item.context?.drafter ? t("home.decide.drafter", { name: item.context.drafter }) : undefined,
    item.site,
    item.ref && item.ref !== primary ? item.ref : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <WorklistSubject title={meta ? `${primary} · ${meta}` : primary}>
      <bdi className={`${s.subjectPrimary} t-ink t-medium`}>{primary}</bdi>
      {meta ? <bdi className={`${s.subjectMeta} t-faint t-xs`}>{meta}</bdi> : null}
    </WorklistSubject>
  );
}
