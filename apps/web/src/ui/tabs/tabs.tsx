// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Tab, TabList, TabPanel, Tabs as AriaTabs } from "react-aria-components";
import { fmtNumber } from "@console/i18n/format";
import s from "./tabs.module.css";

/** Available views only; callers omit refused views using the server's decision. Known nonnegative counts render. */
export type TabItem = { id: string; label: ReactNode; count?: ReactNode };

/**
 * View tabs over one model (chart, list, outline; a record's sections): WAI-ARIA tabs (React Aria) — arrow keys move
 * and select, Home / End jump, Tab leaves the list for the panel. `children(id)` renders the selected view's panel.
 * Pages that are separate routes use TabNav instead (links with aria-current), which looks the same.
 */
export function Tabs({ label, items, selected, onSelect, renderList, children }: {
  label: string;
  items: readonly TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  /** Place the tablist in a page head while its panels stay outside that header. */
  renderList?: (list: ReactNode) => ReactNode;
  children: (id: string) => ReactNode;
}) {
  if (!items.length) return null;
  const current = items.some(i => i.id === selected) ? selected : items[0]!.id;
  const list = (
    <TabList aria-label={label} className={s.list}>
      {items.map((i) => (
        <Tab key={i.id} id={i.id} className={s.tab}>
          {i.label}
          {i.count !== undefined && <TabCount>{i.count}</TabCount>}
        </Tab>
      ))}
    </TabList>
  );
  return (
    <AriaTabs selectedKey={current} onSelectionChange={(k) => onSelect(String(k))} className={s.tabs}>
      {renderList ? renderList(list) : list}
      {items.map((i) => (
        <TabPanel key={i.id} id={i.id} className={s.panel}>{children(i.id)}</TabPanel>
      ))}
    </AriaTabs>
  );
}

/**
 * Tabs that are routes (a vertical's sections: roles, grants, readiness): a labelled nav whose links the caller renders with
 * `tabClass` and marks `aria-current="page"` when current, plus `TabCount` for a count. Not a tablist: each is a page.
 */
export function TabNav({ label, children, overflow }: { label: string; children: ReactNode; overflow?: "scroll" }) {
  return <nav aria-label={label} className={`${s.list} ${overflow === "scroll" ? s.scroll : ""}`}>{children}</nav>;
}

/** Keep unknown counts' layout slots; show zero once the read settles. */
export const TabCount = ({ children }: { children?: ReactNode }) => <span className={s.count}>
  {typeof children === "number" && Number.isFinite(children) && children >= 0 ? fmtNumber(children) : null}
</span>;
