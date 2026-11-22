// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { Table } from "../../../ui/table";
import { consentQuery, myAccessLogPages } from "../api";
import { ConsentBody } from "./consent-card";
import { MyAccessLogBody } from "./me-access-log";
import { PrivacyRetentionSection } from "./privacy-retention";
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
          <Table
            label={t("account.privacy.list")}
            rows={items}
            rowId={item => item.id}
            selected={selectedId}
            onSelect={onSelect}
            columns={[
              { header: t("account.privacy.number"), card: "title", cell: item => item.receipt_no },
              { header: t("account.privacy.controller"), card: "fact", cell: item => item.controller_label },
              { header: t("account.privacy.kinds"), card: "fact", cell: item => item.kinds.map(kind => kind.label).join(" · ") },
              { header: t("account.privacy.received"), card: "omit", cell: item => fmtDateTime(item.received_at), wide: true },
              { header: t("account.privacy.status"), card: "status", cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip> },
              {
                header: t("account.privacy.due"),
                card: "fact",
                cell: item => (
                  <>
                    {item.clock && <DeadlineChip days={item.clock.days_left} severity={item.clock.severity} />}
                    {item.without_delay && t("account.privacy.withoutDelay")}
                    {!item.clock && !item.without_delay && t("account.privacy.noClock")}
                  </>
                ),
              },
            ]}
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
