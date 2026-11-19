// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { isInlineApprovalDecidable, shortMonthDay } from "../features/home/domain/inline-decide";
import type { AttentionInboxItem } from "../features/home/domain/inbox-filter";
import type { RowAction } from "../features/home/ui/grouped-queue";
import { InboxActivity } from "../features/home/ui/inbox-activity";
import { AddPasskey } from "../features/onboarding/ui/add-passkey";
import { InboxCommand } from "../features/org/ui/inbox-command";
import {
  OrgChangeInlineRowActions,
  OrgChangeWorklistBody,
  OrgChangeWorklistDecisionFooter,
} from "../features/org/ui/org-change-worklist";
import { SelfBindingReview } from "../features/people/ui/self-binding-review";
import { UnlockReview } from "../features/periods/ui/unlock-review";
import { DueCell } from "../ui/due-cell/due-cell";

export const inboxAction: RowAction = item => {
  if (item.kind === "account_binding_review" && item.context?.command_id) return <SelfBindingReview id={item.context.command_id} />;
  const link = item.links[0];
  if (link?.kind === "account") return <AddPasskey count={1} focusAfter="inbox-title" />;
  if (link?.kind === "org_change" && item.context?.command) return <InboxCommand id={link.id} command={item.context.command} />;
  if (link?.kind === "period_lock" && item.context?.unlock?.exceptionId) return <UnlockReview lockId={link.id} exceptionId={item.context.unlock.exceptionId} />;
  return null;
};

export function consoleInlineRowAction(
  item: AttentionInboxItem,
  focusAfter: string,
  onSelectForReject: () => void,
) {
  const link = item.links[0];
  if (!isInlineApprovalDecidable(item) || link?.kind !== "org_change") return null;
  return (
    <OrgChangeInlineRowActions
      id={link.id}
      focusAfter={focusAfter}
      onSelectForReject={onSelectForReject}
    />
  );
}

export function consoleRecordBody(item: AttentionInboxItem) {
  const link = item.links[0];
  if (link?.kind !== "org_change") return null;
  const md = shortMonthDay(item.due);
  return (
    <OrgChangeWorklistBody
      id={link.id}
      dueLabel={
        item.days_remaining != null || md ? (
          <>
            {item.due ? <bdi className="num">{t("home.inbox.column.due")} {md ?? fmtDate(item.due)}</bdi> : null}
            {item.days_remaining != null ? <DueCell days={item.days_remaining} /> : null}
          </>
        ) : undefined
      }
      trailing={<InboxActivity id={item.id} />}
    />
  );
}

export function consoleRecordFooter(
  item: AttentionInboxItem,
  focusAfter: string,
  onDecided: () => void,
) {
  const link = item.links[0];
  if (link?.kind !== "org_change") return null;
  return (
    <OrgChangeWorklistDecisionFooter
      id={link.id}
      canDecide={item.can_decide}
      cannotReason={item.cannot_reason}
      focusAfter={focusAfter}
      onDecided={onDecided}
    />
  );
}
