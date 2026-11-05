// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { ReadReference } from "../../../lib/react/read-reference";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Page } from "../../../ui/page/page";
import { KeyValue } from "../../../ui/key-value/key-value";
import { get } from "../../../lib/query";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Button } from "../../../ui/button/button";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../../ui/empty-state";
import { SidePanel } from "../../../ui/side-panel/side-panel";
import { Table } from "../../../ui/table";
import { ApiError, privacyReceipt, privacyRequestPages } from "../api";
import { PrivacyReceipt } from "./privacy-receipt";
import { PrivacyRequest } from "./privacy-request";
import s from "./account.module.css";

export function PrivacyIntake() {
  const { id } = useParams({ from: "/app/account/privacy/intake/$id" });
  const q = useQuery(get("/api/v1/privacy/rights-requests/{id}", { params: { path: { id } } }));
  return <Page floorplan="P-01" head={{ title: t("account.privacy.intake") }} q={q} layout="record">
    {data => <>
      <KeyValue readOnly items={[{ key: "subject", label: t("account.privacy.subject"), value: data.subject_name }]} />
      <PrivacyReceipt request={privacyReceipt(data.request, data.as_of)} />
    </>}
  </Page>;
}

export function PrivacyRequestsView({ items, filed }: { items: PrivacyRightsReceipt[]; filed?: PrivacyRightsReceipt }) {
  const [selectedId, select] = useState<string | undefined>(filed?.id);
  const [seen, setSeen] = useState(filed);
  if (filed !== seen) { setSeen(filed); select(filed?.id); }
  const selected = items.find(item => item.id === selectedId) ?? (filed?.id === selectedId ? filed : undefined);
  return <div className="split" data-open={Boolean(selected)}>
    <Card label={t("account.privacy.list")} flush>
      {items.length ? <Table label={t("account.privacy.list")} rows={items} rowId={item => item.id} selected={selected?.id} onSelect={select} columns={[
        { header: t("account.privacy.number"), card: "title", cell: item => item.receipt_no },
        { header: t("account.privacy.controller"), card: "fact", cell: item => item.controller_label },
        { header: t("account.privacy.kinds"), card: "fact", cell: item => item.kinds.map(kind => kind.label).join(" · ") },
        { header: t("account.privacy.received"), card: "fact", cell: item => fmtDateTime(item.received_at), wide: true },
        { header: t("account.privacy.status"), card: "status", cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip> },
        { header: t("account.privacy.due"), card: "fact", cell: item => <>{item.clock && <DeadlineChip days={item.clock.days_left} severity={item.clock.severity} />}{item.without_delay && t("account.privacy.withoutDelay")}{!item.clock && !item.without_delay && t("account.privacy.noClock")}</> },
      ]} /> : <EmptyState title={t("account.privacy.empty.title")} reason={null} />}
    </Card>
    {selected && <SidePanel open title={selected.receipt_no} onClose={() => select(undefined)}
      returnFocus={() => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected.id)}"]`)}>
      <PrivacyReceipt request={selected} />
    </SidePanel>}
  </div>;
}

export function PrivacyRequests() {
  const q = useInfiniteQuery(privacyRequestPages);
  const [filed, setFiled] = useState<PrivacyRightsReceipt>();
  const head = { title: t("account.privacy.title") };
  if (q.error instanceof ApiError && q.error.status === 403) return <Page floorplan="P-01" head={head}>
    <EmptyState alert title={t("account.privacy.refused.title")} reason={t("account.privacy.refused")}
      actions={<Button onClick={() => void q.refetch()}>{t("common.retry")}</Button>} meta={<ReadReference error={q.error} />} />
  </Page>;
  return <Page floorplan="P-01" head={head} q={q} layout="list">
    {data => <>
      <PrivacyRequest onFiled={setFiled} />
      <PrivacyRequestsView filed={filed} items={data.pages.flatMap(page => page.items)} />
      {q.hasNextPage && <div className={s.pad}><Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t("account.privacy.more")}</Button></div>}
    </>}
  </Page>;
}
