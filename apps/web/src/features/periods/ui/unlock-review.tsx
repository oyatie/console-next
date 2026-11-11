// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { focusSoon } from "../../../lib/react/announce";
import { Button } from "../../../ui/button/button";
import { acknowledgeUnlockReview } from "../api";

export function UnlockReview({ lockId, exceptionId }: { lockId: string; exceptionId: string }) {
  const review = useCommand({
    run: () => acknowledgeUnlockReview(lockId, exceptionId),
    invalidates: ["/api/v1/me/action-inbox"],
    onSuccess: () => focusSoon("inbox-title"),
    announce: () => t("periodLocks.review.done"),
  });
  return <div>
    <Button size="sm" disabled={review.isPending} onClick={() => review.mutate(undefined)}>{t("periodLocks.review.acknowledge")}</Button>
    <CommandError error={review.error} />
  </div>;
}
