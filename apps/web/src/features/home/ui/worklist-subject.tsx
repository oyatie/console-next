// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { INSURER, LIFECYCLE_EVENT, codeText, label } from "../../../lib/labels";
import { reasonLabel } from "../../../lib/reason-codes";
import { domainText, periodText } from "../../../reference/periods/present";
import { WorklistSubject } from "../../../ui/patterns/worklist-parts";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { hasDistinctTaskLead, shortMonthDay } from "../domain/inline-decide";
import s from "./worklist-console.module.css";

export function CompactSubject({ item }: { item: AttentionInboxItem }) {
  const { unlock, insurance, lifecycle, request, correction } = item.context ?? {};
  const leadShownInTask = hasDistinctTaskLead(item);
  const primary =
    item.kind === "privacy_request"
      ? (item.context?.privacy_kinds ?? [])
          .map(code => codeText(`account.privacy.kind.${code}`, t("enum.unknown")))
          .join(" · ")
      : unlock
        ? `${domainText(unlock.domain)} ${periodText(unlock)}`
        : request
          ? codeText(`requests.kind.${request.kind}`, t("requests.kind.OTHER"))
          : leadShownInTask
            ? ""
            : item.title;

  const facts = item.kind === "privacy_request"
    ? [item.who, t("account.privacy.title")]
    : correction
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

  const drafterName = item.context?.drafter?.trim();
  const drafterIncluded = Boolean(drafterName && item.site?.includes(drafterName));
  const detail = [
    ...facts,
    drafterName && !drafterIncluded ? t("home.decide.drafter", { name: drafterName }) : undefined,
    item.site,
    item.ref && item.ref !== primary && !item.site ? item.ref : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const resolvedDetail = detail || (!primary ? item.who?.trim() || item.title?.trim() || "" : "");
  const dueMd = shortMonthDay(item.due);
  const fullTitle = [primary, resolvedDetail].filter(Boolean).join(" · ");
  const phoneDue = dueMd && !fullTitle.includes(dueMd) ? dueMd : undefined;
  if (!primary && !resolvedDetail) return null;

  return (
    <WorklistSubject title={fullTitle}>
      {primary ? (
        <>
          <bdi className={`${s.subjectPrimary} t-ink t-medium`}>{primary}</bdi>
          {resolvedDetail ? <bdi className={`${s.subjectMeta} t-faint t-xs`}>{resolvedDetail}</bdi> : null}
        </>
      ) : (
        <bdi className={s.subjectPrimary}>{resolvedDetail}</bdi>
      )}
      {phoneDue ? <bdi className={s.phoneDue}> · {phoneDue}</bdi> : null}
    </WorklistSubject>
  );
}
