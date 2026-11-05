// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../../ui/empty-state";
import { SidePanel } from "../../../ui/side-panel/side-panel";
import { Table } from "../../../ui/table";
import { PrivacyReceipt } from "./privacy-receipt";

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
