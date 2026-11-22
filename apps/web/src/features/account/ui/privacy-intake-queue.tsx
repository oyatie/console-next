// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { EmptyState } from "../../../ui/empty-state";
import { Receipt } from "../../../ui/receipt/receipt";
import { ApiError, privacyReceipt } from "../api";
import { privacyIntakeListPages } from "../api/privacy-intake";
import { PrivacyReceiptTable } from "./privacy-receipt-table";
import s from "./privacy-intake.module.css";

const PrivacyOffAppComposer = lazy(() =>
  import("./privacy-off-app-composer").then(m => ({ default: m.PrivacyOffAppComposer })),
);

type StatusFilter = "ALL" | "RECEIVED" | "DECIDED";

export function PrivacyIntakeQueue() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [offAppOpen, setOffAppOpen] = useState(false);
  const [receiptMsg, setReceiptMsg] = useState<string | null>(null);

  const queryStatus = statusFilter === "ALL" ? undefined : statusFilter;
  const q = useInfiniteQuery({ ...privacyIntakeListPages(queryStatus), retry: false });

  if (q.error instanceof ApiError && q.error.status === 403) {
    return (
      <Card title={t("privacy.intake.queueTitle")}>
        <EmptyState
          alert
          title={t("privacy.intake.queueRefused")}
          reason={t("privacy.intake.queueEmptyReason")}
        />
      </Card>
    );
  }

  const rows = (q.data?.pages ?? []).flatMap(page =>
    page.items.map(entry => ({
      ...privacyReceipt(entry.request, page.as_of),
      subject_name: entry.subject_name,
    })),
  );

  return (
    <div className={s.section}>
      {receiptMsg && <Receipt state="recorded" message={receiptMsg} />}
      <Card title={t("privacy.intake.queueTitle")} flush>
        <div className={s.filterBar}>
          <ChipChoice
            label={t("account.privacy.status")}
            required={false}
            options={[
              { value: "ALL", label: t("privacy.intake.filter.all") },
              { value: "RECEIVED", label: t("privacy.intake.filter.received") },
              { value: "DECIDED", label: t("privacy.intake.filter.decided") },
            ]}
            value={statusFilter}
            onChange={value => {
              if (value === "ALL" || value === "RECEIVED" || value === "DECIDED") {
                setStatusFilter(value);
              }
            }}
          />
          <Button variant="primary" onClick={() => setOffAppOpen(true)}>
            {t("privacy.intake.offAppOpen")}
          </Button>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={t("privacy.intake.queueEmpty")} reason={t("privacy.intake.queueEmptyReason")} />
        ) : (
          <PrivacyReceiptTable
            label={t("privacy.intake.queueTitle")}
            rows={rows}
            onSelect={id => {
              void navigate({ to: "/account/privacy/intake/$id", params: { id } });
            }}
            secondColumn="subject"
          />
        )}
        {q.hasNextPage && (
          <div className={s.actions}>
            <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {t("privacy.intake.loadMore")}
            </Button>
          </div>
        )}
      </Card>
      {offAppOpen && (
        <Suspense fallback={null}>
          <PrivacyOffAppComposer
            onClose={() => setOffAppOpen(false)}
            onRecorded={created => {
              setOffAppOpen(false);
              setReceiptMsg(t("privacy.intake.offAppReceipt", { receiptNo: created.receipt_no }));
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
