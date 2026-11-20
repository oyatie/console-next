// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { ACCESS_REQUEST_REASONS, requestAccess, type AccessRequestReason } from "../../reference/authz/api";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { reasonProblem, type Reason } from "../../ui/reason/reason";
import { ReasonField } from "../../ui/reason/reason-field";
import { useCommand } from "./command";
import { CommandError } from "./command-error";
import css from "./denied.module.css";

const REASONS = ACCESS_REQUEST_REASONS.map((code) => ({ code, label: t(`common.denied.reason.${code}`) }));

/** Access request form body loaded on demand when the user opens the request form from a refusal card. */
export function DeniedRequestForm({ screen }: { screen: string }) {
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const send = useCommand({
    run: (r: Reason) => requestAccess({ screen, reason_code: r.code as AccessRequestReason, note: r.memo.trim() || null }),
    invalidates: ["/api/v1/access"],
    announce: () => t("common.denied.request.sent"),
  });
  if (send.data) return <Banner live="polite">{t("common.denied.request.sent")}</Banner>;
  return (
    <form
      className={css.form}
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!reasonProblem(reason, "OTHER")) send.mutate(reason);
      }}
    >
      <ReasonField label={t("common.denied.request.reason")} codes={REASONS} other="OTHER" value={reason} onChange={setReason} memoMax={500} showErrors={tried} />
      <CommandError error={send.error} />
      <div className={css.row}>
        <Button variant="primary" type="submit" disabled={send.isPending}>{t("common.denied.request.send")}</Button>
      </div>
    </form>
  );
}
