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
import {
  ApprovalRunInlineRowActions,
  ApprovalRunWorklistBody,
  ApprovalRunWorklistDecisionFooter,
} from "./inbox-action-approval";
import { SelfBindingReview } from "../features/people/ui/self-binding-review";
import { UnlockReview } from "../features/periods/ui/unlock-review";
import { DueCell } from "../ui/due-cell/due-cell";

export const inboxAction: RowAction = (item, focusAfter = "inbox-title") => {
  if (item.kind === "account_binding_review" && item.context?.command_id) return <SelfBindingReview id={item.context.command_id} />;
  const link = item.links?.[0];
  if (link?.kind === "account") return <AddPasskey count={1} focusAfter={focusAfter} />;
  if (link?.kind === "org_change" && item.context?.command) {
    if (item.context.command === "approve" && item.can_decide === false) return null;
    return <InboxCommand id={link.id} command={item.context.command} canDecide={item.can_decide} focusAfter={focusAfter} />;
  }
  if (link?.kind === "period_lock" && item.context?.unlock?.exceptionId) return <UnlockReview lockId={link.id} exceptionId={item.context.unlock.exceptionId} />;
  return null;
};

export function consoleInlineRowAction(
  item: AttentionInboxItem,
  focusAfter: string,
  onSelectForReject: () => void,
  onDecided?: () => void,
) {
  const link = item.links[0];
  if (!isInlineApprovalDecidable(item)) return null;
  if (link?.kind === "org_change") {
    return (
      <OrgChangeInlineRowActions
        id={link.id}
        focusAfter={focusAfter}
        onSelectForReject={onSelectForReject}
        onDecided={onDecided}
      />
    );
  }
  if (link?.kind === "approval_run") {
    return (
      <ApprovalRunInlineRowActions
        id={link.id}
        focusAfter={focusAfter}
        onSelectForReject={onSelectForReject}
        onDecided={onDecided}
      />
    );
  }
  return null;
}

export function consoleRecordBody(item: AttentionInboxItem) {
  const link = item.links[0];
  const md = shortMonthDay(item.due);
  const dueLabel =
    item.days_remaining != null || md ? (
      <>
        {item.due ? <bdi className="num">{t("home.inbox.column.due")} {md ?? fmtDate(item.due)}</bdi> : null}
        {item.days_remaining != null ? <DueCell days={item.days_remaining} /> : null}
      </>
    ) : undefined;

  if (link?.kind === "org_change") {
    return (
      <OrgChangeWorklistBody
        id={link.id}
        dueLabel={dueLabel}
        trailing={<InboxActivity id={item.id} padded hideEmpty />}
      />
    );
  }
  if (link?.kind === "approval_run") {
    return (
      <ApprovalRunWorklistBody
        id={link.id}
        dueLabel={dueLabel}
        trailing={<InboxActivity id={item.id} padded hideEmpty />}
      />
    );
  }
  return null;
}

export function consoleRecordFooter(
  item: AttentionInboxItem,
  focusAfter: string,
  onDecided: () => void,
) {
  const link = item.links[0];
  if (link?.kind === "org_change") {
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
  if (link?.kind === "approval_run") {
    return (
      <ApprovalRunWorklistDecisionFooter
        id={link.id}
        canDecide={item.can_decide}
        cannotReason={item.cannot_reason}
        focusAfter={focusAfter}
        onDecided={onDecided}
      />
    );
  }
  return null;
}
