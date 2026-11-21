// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { readFailureText } from "../../../lib/refusal";
import { QueryState } from "../../../lib/react/query-state";
import { ReadReference } from "../../../lib/react/read-reference";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { myPayslipDocDetailQuery } from "../api";

export function MePayslipSheet({
  docId,
  onClose,
}: {
  docId: string | null;
  onClose: () => void;
}) {
  const q = useQuery({
    ...myPayslipDocDetailQuery(docId ?? ""),
    enabled: Boolean(docId),
  });

  return (
    <Dialog open={docId !== null} title={t("account.hub.payslipSheetTitle")} onClose={onClose}>
      <QueryState
        q={q}
        compact
        denied={
          <EmptyState
            compact
            title={t("common.denied.panel")}
            reason={q.error ? readFailureText(q.error) : null}
            meta={<ReadReference error={q.error} />}
          />
        }
      >
        {doc => (
          <KeyValue
            readOnly
            items={[
              { key: "title", label: t("account.hub.payslip"), value: doc.title },
              { key: "created", label: t("account.hub.payslipIssuedAt"), value: fmtDateTime(doc.created_at) },
            ]}
          />
        )}
      </QueryState>
      <div className="form__actions">
        <Button variant={q.isSuccess ? "primary" : "secondary"} onClick={onClose}>
          {t("composer.dismiss")}
        </Button>
      </div>
    </Dialog>
  );
}
