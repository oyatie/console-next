// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { APPROVAL_ROLE, label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DeadlineChip } from "../../../ui/deadline-chip/deadline-chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { KIND_TEXT, Subject, reasonLines, recordAction, type RowAction } from "./grouped-queue";

/** Item facts come from the loaded queue; opening a column never starts a source read. */
export function InboxRecord({ item, action, onBack }: { item?: AttentionInboxItem; action?: RowAction; onBack: () => void }) {
  if (!item) return <EmptyState title={t("common.read.notFound.title")} reason={t("common.read.notFound.reason")} actions={<Button onClick={onBack}>{t("home.inbox.record.back")}</Button>} />;
  const facts = [
    { key: "subject", label: t("home.inbox.column.subject"), value: <Subject item={item} /> },
    ...(item.who ? [{ key: "owner", label: t("home.inbox.column.owner"), value: item.kind.startsWith("org_change") ? label(APPROVAL_ROLE, item.who) : item.who }] : []),
  ];
  if (item.due) facts.push({ key: "due", label: t("home.inbox.column.due"), value: <>
    {item.days_remaining != null && <DeadlineChip days={item.days_remaining} severity={item.dueTone === "danger" ? "over" : item.dueTone === "warn" ? "due" : "far"} />}
    <div className="num"><time dateTime={item.due}>{fmtDateTime(item.due)}</time></div>
  </> });
  else if (item.age_days != null) facts.push({ key: "age", label: t("home.inbox.column.due"), value: t("home.inbox.aging", { days: item.age_days }) });
  const reason = reasonLines(item).join(" · ");
  if (reason) facts.push({ key: "reason", label: t("home.inbox.record.reason"), value: reason });
  return <>
    <h3>{t(KIND_TEXT[item.kind] ?? "home.inbox.unknown")}</h3>
    <div><Chip tone={item.dueTone}>{t(`home.inbox.filter.${item.lane}`)}</Chip></div>
    <KeyValue items={facts} />
    <div className="row">{action?.(item)}{recordAction(item, undefined, "home.inbox.record.original")}</div>
  </>;
}
