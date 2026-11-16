// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { focusSoon } from "../../../lib/react/announce";
import { Button } from "../../../ui/button/button";
import { reviewSelfAttestedBinding } from "../api/self-binding";
import { PasskeyError } from "../../../lib/react/passkey-error";

export function SelfBindingReview({ id }: { id: string }) {
  const review = useCommand({
    run: (decision: "CONFIRM" | "REVOKE") => reviewSelfAttestedBinding(id, decision),
    invalidates: ["/api/v1/me/action-inbox", "/api/v1/directory", "/api/v1/employees", "/api/v1/users"],
    onSuccess: () => focusSoon("inbox-title"), announce: () => t("people.account.reviewed"),
  });
  return <div>
    <div className="row">
      <Button size="sm" disabled={review.isPending} onClick={() => review.mutate("CONFIRM")}>{t("uiOverrideSheet.stepUp", { action: t("people.account.confirmBinding") })}</Button>
      <Button size="sm" disabled={review.isPending} onClick={() => review.mutate("REVOKE")}>{t("uiOverrideSheet.stepUp", { action: t("people.account.revokeBinding") })}</Button>
    </div>
    <PasskeyError error={review.error} />
  </div>;
}
