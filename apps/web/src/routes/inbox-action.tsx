// SPDX-License-Identifier: LicenseRef-Proprietary
import { UnlockReview } from "../features/periods/ui/unlock-review";
import type { RowAction } from "../features/home/ui/grouped-queue";
import { InboxCommand } from "../features/org/ui/inbox-command";
import { AddPasskey } from "../features/onboarding/ui/add-passkey";

export const inboxAction: RowAction = item => {
  const link = item.links[0];
  if (link?.kind === "account") return <AddPasskey count={1} focusAfter="inbox-title" />;
  if (link?.kind === "org_change" && item.context?.command) return <InboxCommand id={link.id} command={item.context.command} />;
  if (link?.kind === "period_lock" && item.context?.unlock?.exceptionId) return <UnlockReview lockId={link.id} exceptionId={item.context.unlock.exceptionId} />;
  return null;
};
