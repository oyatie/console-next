// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { tg } from "@console/i18n/gallery";
import { useState } from "react";
import { QueryState } from "../../lib/react/query-state";
import { Button } from "../../ui/button/button";
import { Card } from "../../ui/card/card";
import { Chip } from "../../ui/chip";
import { EmptyState } from "../../ui/empty-state";
import { Table } from "../../ui/table";
import { LongTable, type LongColumn } from "../../ui/long-table/long-table";
import type { ListPage } from "../../ui/long-table/paging";

export const order = 217;
type Person = { id: string; name: string };
const page: ListPage<Person> = { items: Array.from({ length: 2000 }, (_, i) => ({ id: `SYN-${i + 1}`, row_index: i + 1, name: i ? tg("sample.person", { n: i + 1 }) : tg("sample.longName") })), total: 2000, next_cursor: null };
const rows = page.items;
const noop = () => undefined;
const error = (status: number) => new ApiError(status, status === 403 ? "forbidden" : "internal", "", [], "op_gallery_columns");

/** Table values are already formatted; the column type owns geometry and alignment only. */
export default function ColumnTypesGallery() {
  const [selected, setSelected] = useState<string>();
  const [retried, setRetried] = useState({ failed: false, stale: false });
  const columns = [
    { id: "text", type: "text", card: "title", rowHeader: true, header: tg("columns.text"), cell: r => r.name },
    { id: "num", type: "num", header: tg("columns.num"), cell: () => fmtNumber(2000) },
    { id: "money", type: "money", header: tg("columns.money"), cell: () => fmtNumber(1234567) },
    { id: "pct", type: "pct", header: tg("columns.pct"), cell: () => "75.5" },
    { id: "date", type: "date", header: tg("columns.date"), cell: () => "2026-10-27" },
    { id: "time", type: "time", header: tg("columns.time"), cell: () => "09:30" },
    { id: "duration", type: "duration", header: tg("columns.duration"), cell: () => "8:30" },
    { id: "code", type: "code", header: tg("columns.code"), cell: r => r.id },
    { id: "status", type: "status", card: "status", header: tg("columns.status"), cell: () => <Chip tone="ok">{t("enum.employeeStatus.ACTIVE")}</Chip> },
    { id: "action", type: "action", card: "action", header: tg("columns.action"), cell: r => <Button variant="ghost" size="sm" onClick={() => setSelected(r.id)}>{tg("columns.open")}</Button> },
  ] satisfies LongColumn<Person>[];
  const table = (data: Person[]) => <Table label={tg("table.one")} rows={data} columns={columns} rowId={r => r.id} selected={selected} onSelect={setSelected} density="compact" />;
  const empty = <EmptyState title={tg("empty.title")} reason={tg("empty.reason")} />;
  return <Card title={tg("columns.title")}>
    <div data-column-contract="populated">{table(rows.slice(0, 1))}</div>
    <div data-column-contract="large">
      <LongTable<Person & { row_index: number }> label={tg("table.many")} rows={rows} columns={columns} rowId={r => r.id} rowIndex={r => r.row_index} density="compact" total={page.total} hasMore={false} onLoadMore={noop} empty={empty} />
    </div>
    <div data-column-contract="loading">
      <LongTable label={t("common.loading")} rows={[]} columns={columns} rowId={r => r.id} loading hasMore={false} onLoadMore={noop} empty={empty} />
    </div>
    <div data-column-contract="empty">
      <QueryState q={{ isPending: false, data: [], error: null, refetch: noop }} empty={() => empty}>{table}</QueryState>
    </div>
    <div data-column-contract="failed">
      <QueryState q={{ isPending: false, data: retried.failed ? rows.slice(0, 1) : undefined, error: retried.failed ? null : error(500), refetch: () => setRetried(s => ({ ...s, failed: true })) }}>{table}</QueryState>
    </div>
    <div data-column-contract="stale">
      <QueryState q={{ isPending: false, data: rows.slice(0, 1), error: retried.stale ? null : error(500), refetch: () => setRetried(s => ({ ...s, stale: true })) }}>{table}</QueryState>
    </div>
    <div data-column-contract="refused">
      <QueryState q={{ isPending: false, data: rows.slice(0, 1), error: error(403), refetch: noop }}>{table}</QueryState>
    </div>
  </Card>;
}
