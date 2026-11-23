// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { Table } from "./table";
import s from "./table-grouped.module.css";

export type { Column } from "./table";

/** Grouped auto-scroll register table with sticky headers, column groups, cell tones, and responsive `tfoot` subtotals. */
export function GroupedTable<R>(props: ComponentProps<typeof Table<R>>) {
  return <Table {...props} tableClassName={s.grouped} groupedStyles={s} />;
}
