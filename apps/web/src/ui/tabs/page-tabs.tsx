// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "@console/i18n";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import { PopoverButton } from "../popover/popover-button";
import { TabCount, type TabItem } from "./tabs";
import s from "./tabs.module.css";

type PageTabItem = TabItem & { disabledReason?: ReactNode };

/** Links for URL views; measure labels so overflow follows available space and translated copy. */
export function PageTabs({ label, items, selected, onSelect, href, renderList, children }: {
  label: string; items: readonly PageTabItem[]; selected: string;
  onSelect: (id: string) => void; href: (id: string) => string;
  renderList?: (list: ReactNode) => ReactNode; children: (id: string) => ReactNode;
}) {
  const current = items.find(i => i.id === selected && !i.disabledReason) ?? items.find(i => !i.disabledReason);
  const row = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<readonly string[]>(items.map(i => i.id));
  useLayoutEffect(() => {
    if (!items.length) return;
    const fit = () => {
      const elements = Array.from(measure.current!.children) as HTMLElement[];
      const widths = elements.slice(0, -1).map(el => el.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(row.current!).columnGap) || 0;
      const available = row.current!.clientWidth;
      let next = items.map(i => i.id);
      if (widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1) > available) {
        next = current ? [current.id] : [];
        let used = (widths[items.indexOf(current!)] ?? 0) + elements.at(-1)!.getBoundingClientRect().width + gap;
        items.forEach((item, index) => {
          if (item.id !== current?.id && used + widths[index]! + gap <= available) {
            next.push(item.id);
            used += widths[index]! + gap;
          }
        });
      }
      setVisible(previous => previous.join("\0") === next.join("\0") ? previous : next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row.current!);
    for (const element of measure.current!.children) observer.observe(element);
    return () => observer.disconnect();
  }, [items, current]);
  const content = (item: PageTabItem) => <><span className={s.label}>{item.label}</span>{item.count !== undefined && <TabCount>{item.count}</TabCount>}</>;
  const link = (item: PageTabItem, close?: () => void) => item.disabledReason ?
    <DisabledReason key={item.id} layout="disclosure" reason={item.disabledReason} control={p => <span role="link" tabIndex={0} aria-disabled={p["aria-disabled"]} aria-describedby={p["aria-describedby"]} className={`${s.tab} ${p.className}`}>{content(item)}</span>} /> :
    <a key={item.id} className={s.tab} href={href(item.id)} aria-current={item.id === current?.id ? "page" : undefined} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onSelect(item.id);
      close?.();
    }}>{content(item)}</a>;
  const overflow = items.filter(i => !visible.includes(i.id));
  const list = <nav ref={row} aria-label={label} className={`${s.list} ${s.pageList}`}>
    <div ref={measure} className={s.measure} aria-hidden inert>
      {items.map(item => <span key={item.id} className={s.tab}>{content(item)}</span>)}
      <span className="btn btn--ghost">{t("common.more")}</span>
    </div>
    {items.filter(i => visible.includes(i.id)).map(item => link(item))}
    {overflow.length > 0 && <PopoverButton trigger={t("common.more")} label={t("common.more")} title={t("common.more")}>
      {close => <div className={s.overflow}>{overflow.map(item => link(item, close))}</div>}
    </PopoverButton>}
  </nav>;
  if (!items.length) return null;
  return <div className={s.tabs}>
    {renderList ? renderList(list) : list}
    {current && <div key={current.id} className={s.panel} data-page-view={current.id}>{children(current.id)}</div>}
  </div>;
}
