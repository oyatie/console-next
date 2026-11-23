// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button-base";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { consentQuery, myAccessLogPages } from "../api";
import { ConsentBody } from "./consent-card";
import { MyAccessLogBody } from "./me-access-log";
import { PrivacyRetentionSection } from "./privacy-retention";
import { PrivacyReceiptTable } from "./privacy-receipt-table";
import s from "./account.module.css";

export function PrivacySummary({ items }: { items: PrivacyRightsReceipt[] }) {
  const consent = useQuery({ ...consentQuery, retry: false });
  const openCount = items.filter(item => item.status.code === "RECEIVED").length;
  const consentValue = consent.data
    ? (consent.data.accepted ? t("account.privacy.consentAccepted") : t("account.privacy.consentPending"))
    : consent.isError
      ? t("settingsHub.unknown")
      : t("common.loading");
  return (
    <StatRow
      label={t("account.privacy.summary.label")}
      items={[
        { key: "open", label: t("account.privacy.summary.open"), value: String(openCount), tone: openCount > 0 ? "primary" : undefined },
        { key: "total", label: t("account.privacy.summary.total"), value: String(items.length) },
        { key: "consent", label: t("account.privacy.summary.consent"), value: consentValue },
      ]}
    />
  );
}

export function PrivacyConsolePanel({
  items,
  selectedId,
  onSelect,
  filingSection,
  loadMoreRequests,
}: {
  items: PrivacyRightsReceipt[];
  selectedId?: string;
  onSelect: (id: string) => void;
  filingSection: ReactNode;
  loadMoreRequests: ReactNode;
}) {
  const logQuery = useInfiniteQuery({ ...myAccessLogPages, retry: false });
  const pagedAccessLog = {
    ...logQuery,
    data: logQuery.data
      ? {
          items: logQuery.data.pages.flatMap(page => page.items),
          next_cursor: logQuery.data.pages.at(-1)?.next_cursor ?? null,
        }
      : undefined,
  } as Parameters<typeof MyAccessLogBody>[0]["q"];

  const hideEmptyLog = logQuery.isSuccess && (logQuery.data?.pages.every(p => p.items.length === 0) ?? false);

  return (
    <div className={s.consoleSections}>
      <div id="privacy-rights">{filingSection}</div>
      <RecordPaneSection title={t("account.privacy.listTitle")} padded={items.length === 0}>
        {items.length ? (
          <PrivacyReceiptTable
            label={t("account.privacy.list")}
            rows={items}
            selected={selectedId}
            onSelect={onSelect}
            secondColumn="controller"
          />
        ) : (
          <EmptyState title={t("account.privacy.empty.title")} reason={null} />
        )}
        {loadMoreRequests}
      </RecordPaneSection>
      {!hideEmptyLog && (
        <div id="privacy-access-log">
          <RecordPaneSection title={t("account.accessLog.title")}>
            <MyAccessLogBody q={pagedAccessLog} />
            {logQuery.hasNextPage && (
              <div>
                <Button disabled={logQuery.isFetchingNextPage} onClick={() => void logQuery.fetchNextPage()}>
                  {t("account.privacy.accessLog.more")}
                </Button>
              </div>
            )}
          </RecordPaneSection>
        </div>
      )}
      <div id="privacy-consent">
        <RecordPaneSection title={t("account.consent.title")}>
          <ConsentBody />
        </RecordPaneSection>
      </div>
      <div id="privacy-retention">
        <RecordPaneSection title={t("account.privacy.retention.title")}>
          <PrivacyRetentionSection />
        </RecordPaneSection>
      </div>
    </div>
  );
}
