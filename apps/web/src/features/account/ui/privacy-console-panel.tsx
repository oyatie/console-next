// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
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

  return (
    <>
      <div id="privacy-rights">{filingSection}</div>
      <Card title={t("account.privacy.listTitle")} flush>
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
      </Card>
      <Card id="privacy-access-log" title={t("account.accessLog.title")}>
        <div className={s.pad}>
          <MyAccessLogBody q={pagedAccessLog} />
          {logQuery.hasNextPage && (
            <div>
              <Button disabled={logQuery.isFetchingNextPage} onClick={() => void logQuery.fetchNextPage()}>
                {t("account.privacy.accessLog.more")}
              </Button>
            </div>
          )}
        </div>
      </Card>
      <Card id="privacy-consent" title={t("account.consent.title")}>
        <div className={s.pad}>
          <ConsentBody />
        </div>
      </Card>
      <Card id="privacy-retention" title={t("account.privacy.retention.title")}>
        <div className={s.pad}>
          <PrivacyRetentionSection />
        </div>
      </Card>
    </>
  );
}
