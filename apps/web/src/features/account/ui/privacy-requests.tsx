// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Button } from "../../../ui/button/button";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../../ui/empty-state";
import { SidePanel } from "../../../ui/side-panel/side-panel";
import { Table } from "../../../ui/table";
import { privacyRequestPages } from "../api";
import { PrivacyReceipt } from "./privacy-receipt";
import s from "./account.module.css";

export function PrivacyRequestsView({ items }: { items: PrivacyRightsReceipt[] }) {
  const [selectedId, select] = useState<string>();
  const selected = items.find(item => item.id === selectedId);
  return <div className="split" data-open={Boolean(selected)}>
    <Card label={t("account.privacy.list")} flush>
      {items.length ? <Table label={t("account.privacy.list")} rows={items} rowId={item => item.id} selected={selected?.id} onSelect={select} columns={[
        { header: t("account.privacy.number"), card: "title", cell: item => item.receipt_no },
        { header: t("account.privacy.controller"), card: "fact", cell: item => item.controller_label },
        { header: t("account.privacy.kinds"), card: "fact", cell: item => item.kinds.map(kind => kind.label).join(" · ") },
        { header: t("account.privacy.received"), card: "fact", cell: item => fmtDateTime(item.received_at), wide: true },
        { header: t("account.privacy.status"), card: "status", cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip> },
        { header: t("account.privacy.due"), card: "fact", cell: item => item.clock ? <DeadlineChip days={item.clock.days_left} severity={item.clock.severity} /> : "—" },
      ]} /> : <EmptyState title={t("account.privacy.empty.title")} reason={t("account.privacy.empty.reason")} />}
    </Card>
    {selected && <SidePanel open title={selected.receipt_no} onClose={() => select(undefined)}
      returnFocus={() => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected.id)}"]`)}>
      <PrivacyReceipt request={selected} />
    </SidePanel>}
  </div>;
}

export function PrivacyRequests() {
  const q = useInfiniteQuery(privacyRequestPages);
  return <Page floorplan="P-01" head={{ title: t("account.privacy.title") }} q={q} layout="list">
    {data => <>
      <PrivacyRequestsView items={data.pages.flatMap(page => page.items)} />
      {q.hasNextPage && <div className={s.pad}><Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t("account.privacy.more")}</Button></div>}
    </>}
  </Page>;
}
