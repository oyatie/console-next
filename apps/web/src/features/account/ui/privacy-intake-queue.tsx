// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { EmptyState } from "../../../ui/empty-state";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { ApiError, privacyReceipt } from "../api";
import { privacyIntakeListPages, type WirePrivacyReceipt } from "../api/privacy-intake";
import { PrivacyReceiptTable } from "./privacy-receipt-table";
import accountStyles from "./account.module.css";
import s from "./privacy-intake.module.css";

const PrivacyOffAppComposer = lazy(() =>
  import("./privacy-off-app-composer").then(m => ({ default: m.PrivacyOffAppComposer })),
);

type StatusFilter = "ALL" | "RECEIVED" | "DECIDED";
export type IntakeQueueSelection = { request: WirePrivacyReceipt; subject_name: string; as_of: string };

export function PrivacyIntakeQueue({
  selectedId,
  onSyncRows,
}: {
  selectedId?: string;
  onSyncRows?: (items: IntakeQueueSelection[]) => void;
}) {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [offAppOpen, setOffAppOpen] = useState(false);
  const [receiptMsg, setReceiptMsg] = useState<string | null>(null);

  const queryStatus = statusFilter === "ALL" ? undefined : statusFilter;
  const q = useInfiniteQuery({ ...privacyIntakeListPages(queryStatus), retry: false });

  const items: IntakeQueueSelection[] = useMemo(
    () =>
      (q.data?.pages ?? []).flatMap(page =>
        page.items.map(entry => ({
          request: entry.request,
          subject_name: entry.subject_name,
          as_of: page.as_of,
        })),
      ),
    [q.data?.pages],
  );

  useEffect(() => {
    onSyncRows?.(items);
  }, [items, onSyncRows]);

  if (q.error instanceof ApiError && q.error.status === 403) {
    return (
      <RecordPaneSection title={t("privacy.intake.queueTitle")}>
        <EmptyState
          alert
          title={t("privacy.intake.queueRefused")}
          reason={t("privacy.intake.queueEmptyReason")}
        />
      </RecordPaneSection>
    );
  }

  const rows = items.map(entry => ({
    ...privacyReceipt(entry.request, entry.as_of),
    subject_name: entry.subject_name,
  }));

  return (
    <div className={s.section}>
      {receiptMsg && <Receipt state="recorded" message={receiptMsg} />}
      <RecordPaneSection title={t("privacy.intake.queueTitle")} padded={false}>
        <div className={accountStyles.pad}>
          <div className={s.filterBar}>
            <Segmented
              label={t("account.privacy.status")}
              size="sm"
              value={statusFilter}
              onChange={value => {
                if (value === "ALL" || value === "RECEIVED" || value === "DECIDED") {
                  setStatusFilter(value);
                }
              }}
              items={[
                { id: "ALL", label: t("privacy.intake.filter.all") },
                { id: "RECEIVED", label: t("privacy.intake.filter.received") },
                { id: "DECIDED", label: t("privacy.intake.filter.decided") },
              ]}
            />
            <Button size="sm" variant="primary" onClick={() => setOffAppOpen(true)}>
              {t("privacy.intake.offAppOpen")}
            </Button>
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={t("privacy.intake.queueEmpty")} reason={t("privacy.intake.queueEmptyReason")} />
        ) : (
          <PrivacyReceiptTable
            label={t("privacy.intake.queueTitle")}
            rows={rows}
            selected={selectedId}
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
      </RecordPaneSection>
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
