// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Sheet } from "../../../ui/sheet/sheet";
import type { AccessGrant } from "../api";
import { enforcementText, periodText, storedScope } from "../present";

export function AccessReviewDetailSheet({
  grant,
  onClose,
}: {
  grant: AccessGrant;
  onClose: () => void;
}) {
  return (
    <Sheet
      open
      title={grant.account_display_name ?? grant.account_employee_number ?? t("accessReview.detail.title")}
      onClose={onClose}
      consequence={null}
      actions={
        <>
          <Link to="/access/people/$accountId" params={{ accountId: grant.account_id }} className={buttonClass("primary")}>
            {t("accessReview.detail.openAccount")}
          </Link>
          <Button onClick={onClose}>{t("accessReview.detail.close")}</Button>
        </>
      }
    >
      <KeyValue
        readOnly
        items={[
          { key: "person", label: t("accessReview.person"), value: grant.account_display_name ?? "—" },
          { key: "number", label: t("accessReview.number"), value: grant.account_employee_number ?? "—" },
          { key: "unit", label: t("accessReview.detail.unit"), value: grant.account_unit ?? "—" },
          { key: "role", label: t("accessReview.role"), value: grant.role_name_ko },
          { key: "scope", label: t("accessReview.scope"), value: storedScope(grant.scope) },
          { key: "period", label: t("accessReview.period"), value: periodText(grant) },
          { key: "state", label: t("accessReview.state"), value: enforcementText(grant.enforcement) },
        ]}
      />
    </Sheet>
  );
}
