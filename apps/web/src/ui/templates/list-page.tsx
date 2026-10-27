// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Page, type PageReadProps } from "../page/page";
import type { PageHeadProps } from "../page-head/page-head";
import { shown } from "../shown";
import s from "./list-page.module.css";

/** Page keeps query controls mounted during reads and owns the refusal boundary. */
export function ListPage<T>({ head, filters, toolbar, sheet, children, ...read }: PageReadProps<T> & {
  head: PageHeadProps;
  filters?: ReactNode;
  toolbar?: ReactNode;
  sheet?: ReactNode;
}) {
  return <Page floorplan="list" head={head} {...read} toolbar={shown(filters) || shown(toolbar) ? <div className={s.content}>
    {shown(filters) && <div className={s.tools} data-list-region="filters">{filters}</div>}
    {shown(toolbar) && <div className={s.tools} data-list-region="toolbar">{toolbar}</div>}
  </div> : undefined} sheet={sheet}>
    {(data: T) => <div className={s.body} data-list-region="body">{children(data)}</div>}
  </Page>;
}
