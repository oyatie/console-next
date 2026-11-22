// SPDX-License-Identifier: LicenseRef-Proprietary
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../../ui/button/button-base";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { PrivacyDueCell } from "./privacy-receipt";
import s from "./account.module.css";

type PrivacyTableRow = PrivacyRightsReceipt & { subject_name?: string };

export function PrivacyReceiptTable({
  label,
  rows,
  selected,
  onSelect,
  secondColumn,
}: {
  label: string;
  rows: PrivacyTableRow[];
  selected?: string;
  onSelect: (id: string) => void;
  secondColumn: "controller" | "subject";
}) {
  return (
    <Table
      label={label}
      rows={rows}
      rowId={item => item.id}
      selected={selected}
      onSelect={onSelect}
      scrollLayout="auto"
      density="compact"
      mobileLayout="compact"
      columns={[
        { header: t("account.privacy.number"), card: "title", cell: item => item.receipt_no },
        secondColumn === "subject"
          ? { header: t("account.privacy.subject"), card: "omit", cell: item => item.subject_name ?? "—" }
          : { header: t("account.privacy.controller"), card: "omit", cell: item => item.controller_label },
        { header: t("account.privacy.kinds"), card: "omit", cell: item => item.kinds.map(kind => kind.label).join(" · ") },
        ...(secondColumn === "controller"
          ? [{ header: t("account.privacy.received"), card: "omit" as const, cell: (item: PrivacyTableRow) => fmtDateTime(item.received_at), wide: true }]
          : []),
        { header: t("account.privacy.status"), card: "status", cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip> },
        {
          header: t("account.privacy.due"),
          card: "fact",
          cell: item => <PrivacyDueCell clock={item.clock} withoutDelay={item.without_delay} />,
        },
        {
          header: <bdi className="sr-only">{t("privacy.intake.openRow")}</bdi>,
          type: "action",
          fit: true,
          card: "action",
          cell: item => (
            <Button
              size="sm"
              variant="secondary"
              className={s.actionBtn}
              onClick={event => {
                event.stopPropagation();
                onSelect(item.id);
              }}
            >
              {t("privacy.intake.openRow")}
            </Button>
          ),
        },
      ]}
    />
  );
}
