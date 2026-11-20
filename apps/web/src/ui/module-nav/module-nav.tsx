// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { t } from "@console/i18n";
import { chunk } from "../../lib/chunk-guard";
import { partitionBarOverflow } from "../bar-overflow";
import { Badge } from "../badge/badge";
import s from "./module-nav.module.css";

const BarOverflowLinks = lazy(() =>
  chunk(import("../bar-overflow-links")).then(m => ({ default: m.BarOverflowLinks })),
);

export type ModuleNavItem = {
  /** Stable identifier for the module destination. */
  id: string;
  /** Translated module label. */
  label: string;
  /** Destination URL for native link navigation. */
  href: string;
  /** Positive actionable count shown beside the module label. */
  count?: number;
};

type ModuleNavLinkRenderProps = {
  className: string;
  "aria-current"?: "page";
  children: ReactNode;
};

/**
 * Horizontal primary module navigation bar inside the application frame. Measures inline item widths and folds excess
 * destinations into an overflow menu while keeping the active module visible inline whenever space allows.
 */
export function ModuleNavBar({
  label,
  items,
  activeId,
  moreLabel,
  onNavigate,
  renderLink,
}: {
  /** Accessible name of the primary navigation landmark. */
  label: string;
  /** Ordered module destinations the signed-in account can open. */
  items: readonly ModuleNavItem[];
  /** Identifier of the active module marked with `aria-current="page"`. */
  activeId?: string;
  /** Accessible name for the overflow trigger; defaults to `shell.nav.more`. */
  moreLabel?: string;
  /** Invoked when a plain primary click or overflow menu selection activates an item. */
  onNavigate?: (item: ModuleNavItem) => void;
  /** Optional custom link renderer for router integration; falls back to a native `<a>` element. */
  renderLink?: (item: ModuleNavItem, props: ModuleNavLinkRenderProps) => ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const activeIndex = activeId !== undefined ? items.findIndex(item => item.id === activeId) : -1;
  const [overflowState, setOverflowState] = useState<{
    count: number;
    visibleIndices: number[];
    overflowIndices: number[];
  } | null>(null);

  useLayoutEffect(() => {
    if (items.length === 0 || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const navEl = navRef.current;
      const measureEl = measureRef.current;
      if (!navEl || !measureEl) return;
      const children = Array.from(measureEl.children) as HTMLElement[];
      if (children.length < items.length + 1) return;
      const widths = children.slice(0, items.length).map(el => el.getBoundingClientRect().width);
      const reserve = children[items.length]!.getBoundingClientRect().width;
      const next = partitionBarOverflow(widths, navEl.clientWidth, reserve, activeIndex);
      setOverflowState(prev =>
        prev &&
        prev.count === items.length &&
        prev.visibleIndices.join(",") === next.visibleIndices.join(",") &&
        prev.overflowIndices.join(",") === next.overflowIndices.join(",")
          ? prev
          : { count: items.length, ...next },
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (navRef.current) observer.observe(navRef.current);
    if (measureRef.current) {
      for (const child of measureRef.current.children) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [items, activeIndex]);

  if (items.length === 0) return null;

  const partition =
    overflowState && overflowState.count === items.length
      ? overflowState
      : { visibleIndices: items.map((_, idx) => idx), overflowIndices: [] };
  const visibleIndices = partition.visibleIndices.filter(idx => idx >= 0 && idx < items.length);
  const overflowIndices = partition.overflowIndices.filter(idx => idx >= 0 && idx < items.length);
  const resolvedMoreLabel = moreLabel ?? t("shell.nav.more");

  const renderContent = (item: ModuleNavItem) => (
    <>
      <bdi>{item.label}</bdi>
      {item.count !== undefined && item.count > 0 ? <Badge count={item.count} tone="attention" /> : null}
    </>
  );

  const renderItem = (item: ModuleNavItem) => {
    const isCurrent = item.id === activeId;
    const linkProps: ModuleNavLinkRenderProps = {
      className: s.link!,
      "aria-current": isCurrent ? "page" : undefined,
      children: renderContent(item),
    };
    if (renderLink) return renderLink(item, linkProps);
    return (
      <a
        href={item.href}
        className={linkProps.className}
        aria-current={linkProps["aria-current"]}
        onClick={
          onNavigate
            ? event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onNavigate(item);
              }
            : undefined
        }
      >
        {linkProps.children}
      </a>
    );
  };

  return (
    <nav ref={navRef} aria-label={label} className={s.nav}>
      <div ref={measureRef} className={s.measure} aria-hidden="true" inert>
        {items.map(item => (
          <div key={item.id} className={s.link}>
            {renderContent(item)}
          </div>
        ))}
        <div className={s.more}>
          <div className="btn btn--ghost">
            <Ellipsis size={16} aria-hidden="true" />
          </div>
        </div>
      </div>
      <ul className={s.list}>
        {visibleIndices.map(idx => {
          const item = items[idx]!;
          return (
            <li key={item.id} className={s.entry}>
              {renderItem(item)}
            </li>
          );
        })}
      </ul>
      {overflowIndices.length > 0 ? (
        <div className={s.more}>
          <Suspense fallback={null}>
            <BarOverflowLinks
              label={resolvedMoreLabel}
              trigger={<Ellipsis size={16} aria-hidden="true" />}
              entries={overflowIndices.map(idx => {
                const item = items[idx]!;
                return {
                  id: item.id,
                  label: item.label,
                  href: item.href,
                  count: item.count,
                  current: item.id === activeId,
                };
              })}
              onSelect={
                onNavigate
                  ? entry => {
                      const matched = items.find(item => item.id === entry.id);
                      if (matched) onNavigate(matched);
                    }
                  : undefined
              }
            />
          </Suspense>
        </div>
      ) : null}
    </nav>
  );
}
