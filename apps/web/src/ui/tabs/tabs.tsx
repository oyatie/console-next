import type { ReactNode } from "react";
import { Tab, TabList, TabPanel, Tabs as AriaTabs } from "react-aria-components";
import s from "./tabs.module.css";

/** One view: `count` shows after the label (a number, or nothing while it loads: the slot keeps its width). */
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
  const list = (
    <TabList aria-label={label} className={s.list}>
      {items.map((i) => (
        <Tab key={i.id} id={i.id} className={s.tab}>
          {i.label}
          {i.count !== undefined && <span className={s.count}>{i.count}</span>}
        </Tab>
      ))}
    </TabList>
  );
  return (
    <AriaTabs selectedKey={selected} onSelectionChange={(k) => onSelect(String(k))} className={s.tabs}>
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
export function TabNav({ label, children }: { label: string; children: ReactNode }) {
  return <nav aria-label={label} className={s.list}>{children}</nav>;
}

/** The count after a tab's label; empty keeps its width while the count loads. */
export const TabCount = ({ children }: { children?: ReactNode }) => <span className={s.count}>{children}</span>;
