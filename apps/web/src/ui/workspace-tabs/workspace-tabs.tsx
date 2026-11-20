// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Ellipsis, Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { chunk } from "../../lib/chunk-guard";
import { isImeKey } from "../../lib/pure/ime";
import { partitionBarOverflow } from "../bar-overflow";
import { Badge } from "../badge/badge";
import s from "./workspace-tabs.module.css";

const BarOverflowLinks = lazy(() =>
  chunk(import("../bar-overflow-links")).then(m => ({ default: m.BarOverflowLinks })),
);

export type WorkspaceTab = {
  /** Stable identifier of the open workspace tab. */
  id: string;
  /** Translated tab title. */
  label: string;
  /** Destination URL of the workspace. */
  href: string;
  /** Optional leading icon rendered before the tab label. */
  icon?: ReactNode;
  /** Optional positive count displayed beside the tab title. */
  count?: number;
  /** Whether the tab cannot be closed; the first tab (`index === 0`) is always pinned. */
  pinned?: boolean;
};

type WorkspaceTabLinkRenderProps = {
  className: string;
  "aria-current"?: "page";
  "data-workspace-tab": "";
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
};

/**
 * Browser-like strip of open workspace tabs below the top frame bar. Keeps the first tab pinned without a close
 * button, places each close button as a sibling of its link (never nested), supports ArrowLeft/ArrowRight/Home/End
 * focus movement across tab links, and folds excess tabs into an overflow menu.
 */
export function WorkspaceTabs({
  label,
  tabs,
  activeId,
  moreLabel,
  newTabLabel,
  closeTabLabel,
  onSelect,
  onClose,
  onAdd,
  renderLink,
}: {
  /** Accessible name of the workspace tabs navigation landmark; defaults to `shell.tabs.label`. */
  label?: string;
  /** Ordered open workspace tabs; index `0` is pinned and never renders a close button. */
  tabs: readonly WorkspaceTab[];
  /** Identifier of the active workspace tab marked with `aria-current="page"`. */
  activeId?: string;
  /** Accessible name for the overflow menu trigger; defaults to `shell.tabs.more`. */
  moreLabel?: string;
  /** Accessible name for the optional `+` new-tab button; defaults to `shell.tabs.new`. */
  newTabLabel?: string;
  /** Accessible name formatter for a closable tab's close button; defaults to `shell.tabs.closeOne`. */
  closeTabLabel?: (tabLabel: string) => string;
  /** Invoked when a plain primary click or overflow menu selection activates a tab. */
  onSelect?: (tab: WorkspaceTab) => void;
  /** Invoked when the user closes a non-pinned tab. */
  onClose?: (tabId: string) => void;
  /** Optional callback to open a new workspace tab (`+` button). */
  onAdd?: () => void;
  /** Optional custom link renderer for router integration; falls back to a native `<a>` element. */
  renderLink?: (tab: WorkspaceTab, props: WorkspaceTabLinkRenderProps) => ReactNode;
}) {
  const stripRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const activeIndex = activeId !== undefined ? tabs.findIndex(tab => tab.id === activeId) : 0;
  const hasAdd = Boolean(onAdd);
  const hasClose = Boolean(onClose);
  const [overflowState, setOverflowState] = useState<{
    count: number;
    visibleIndices: number[];
    overflowIndices: number[];
  } | null>(null);

  useLayoutEffect(() => {
    if (tabs.length === 0 || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const stripEl = stripRef.current;
      const measureEl = measureRef.current;
      if (!stripEl || !measureEl) return;
      const children = Array.from(measureEl.children) as HTMLElement[];
      if (children.length < tabs.length + 1) return;
      const widths = children.slice(0, tabs.length).map(el => el.getBoundingClientRect().width);
      const tailEl = children[tabs.length];
      const controlsReserve = children
        .slice(tabs.length)
        .reduce((sum, el) => sum + Math.ceil(Math.max(el.getBoundingClientRect().width, el.scrollWidth)), 0);
      const addEl = tailEl?.querySelector<HTMLElement>(`.${s.addBtn}`);
      const tailStyle = tailEl ? getComputedStyle(tailEl) : null;
      const persistentReserve =
        hasAdd && addEl && tailStyle
          ? Math.ceil(
              addEl.getBoundingClientRect().width +
                (parseFloat(tailStyle.paddingInlineStart || tailStyle.paddingLeft || "0") || 0) +
                (parseFloat(tailStyle.paddingInlineEnd || tailStyle.paddingRight || "0") || 0),
            )
          : 0;
      const next = partitionBarOverflow(
        widths,
        stripEl.clientWidth,
        controlsReserve,
        activeIndex,
        persistentReserve,
      );
      setOverflowState(prev =>
        prev &&
        prev.count === tabs.length &&
        prev.visibleIndices.join(",") === next.visibleIndices.join(",") &&
        prev.overflowIndices.join(",") === next.overflowIndices.join(",")
          ? prev
          : { count: tabs.length, ...next },
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (stripRef.current) observer.observe(stripRef.current);
    if (measureRef.current) {
      for (const child of measureRef.current.children) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [tabs, activeIndex, hasAdd, hasClose]);

  if (tabs.length === 0) return null;

  const partition =
    overflowState && overflowState.count === tabs.length
      ? overflowState
      : { visibleIndices: tabs.map((_, idx) => idx), overflowIndices: [] };
  const visibleIndices = partition.visibleIndices.filter(idx => idx >= 0 && idx < tabs.length);
  const overflowIndices = partition.overflowIndices.filter(idx => idx >= 0 && idx < tabs.length);
  const resolvedLabel = label ?? t("shell.tabs.label");
  const resolvedMoreLabel = moreLabel ?? t("shell.tabs.more");
  const resolvedNewLabel = newTabLabel ?? t("shell.tabs.new");
  const formatCloseLabel = closeTabLabel ?? ((name: string) => t("shell.tabs.closeOne", { name }));

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isImeKey(event)) return;
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const stripEl = event.currentTarget.closest("nav");
    if (!stripEl) return;
    const links = Array.from(stripEl.querySelectorAll<HTMLElement>("[data-workspace-tab]"));
    const idx = links.indexOf(event.currentTarget);
    if (idx < 0 || links.length === 0) return;
    event.preventDefault();
    const nextIdx =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : event.key === "ArrowRight"
            ? (idx + 1) % links.length
            : (idx - 1 + links.length) % links.length;
    links[nextIdx]?.focus();
  };

  const renderContent = (tab: WorkspaceTab) => (
    <>
      {tab.icon ? (
        <bdi className={s.icon} aria-hidden="true">
          {tab.icon}
        </bdi>
      ) : null}
      <bdi className={s.title}>{tab.label}</bdi>
      {tab.count !== undefined && tab.count > 0 ? <Badge count={tab.count} /> : null}
    </>
  );

  const isClosable = (tab: WorkspaceTab, index: number) => Boolean(onClose) && index > 0 && !tab.pinned;

  const handleClose = (tabId: string, visiblePosition: number) => {
    if (!onClose) return;
    const stripEl = stripRef.current;
    const links = stripEl ? Array.from(stripEl.querySelectorAll<HTMLElement>("[data-workspace-tab]")) : [];
    const fallbackTarget = links[visiblePosition + 1] ?? links[visiblePosition - 1];
    onClose(tabId);
    fallbackTarget?.focus();
  };

  return (
    <nav ref={stripRef} aria-label={resolvedLabel} className={s.strip}>
      <div ref={measureRef} className={s.measure} aria-hidden="true" inert>
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId || (activeId === undefined && index === 0);
          const closable = isClosable(tab, index);
          return (
            <div
              key={tab.id}
              className={s.cell}
              data-active={isActive || undefined}
              data-closable={closable || undefined}
            >
              <div className={s.tabLink}>{renderContent(tab)}</div>
              {closable ? (
                <div className={s.close}>
                  <X size={12} aria-hidden="true" />
                </div>
              ) : null}
            </div>
          );
        })}
        <div className={s.tail}>
          {onAdd ? (
            <div className={s.addBtn}>
              <Plus size={14} aria-hidden="true" />
            </div>
          ) : null}
          <div className={s.moreWrap}>
            <div className="btn btn--ghost">
              <Ellipsis size={16} aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>

      <ul className={s.list}>
        {visibleIndices.map((tabIndex, visiblePos) => {
          const tab = tabs[tabIndex]!;
          const isActive = tab.id === activeId || (activeId === undefined && tabIndex === 0);
          const closable = isClosable(tab, tabIndex);
          const linkProps: WorkspaceTabLinkRenderProps = {
            className: s.tabLink!,
            "aria-current": isActive ? "page" : undefined,
            "data-workspace-tab": "",
            onKeyDown: onTabKeyDown,
            children: renderContent(tab),
          };
          return (
            <li
              key={tab.id}
              className={s.cell}
              data-active={isActive || undefined}
              data-closable={closable || undefined}
            >
              {renderLink ? (
                renderLink(tab, linkProps)
              ) : (
                <a
                  href={tab.href}
                  className={linkProps.className}
                  aria-current={linkProps["aria-current"]}
                  data-workspace-tab=""
                  onKeyDown={linkProps.onKeyDown}
                  onClick={
                    onSelect
                      ? event => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                            return;
                          }
                          event.preventDefault();
                          onSelect(tab);
                        }
                      : undefined
                  }
                >
                  {linkProps.children}
                </a>
              )}
              {closable ? (
                <button
                  type="button"
                  className={s.close}
                  aria-label={formatCloseLabel(tab.label)}
                  onClick={() => handleClose(tab.id, visiblePos)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className={s.tail}>
        {onAdd ? (
          <button type="button" className={s.addBtn} aria-label={resolvedNewLabel} onClick={onAdd}>
            <Plus size={14} aria-hidden="true" />
          </button>
        ) : null}
        {overflowIndices.length > 0 ? (
          <div className={s.moreWrap}>
            <Suspense fallback={null}>
              <BarOverflowLinks
                label={resolvedMoreLabel}
                trigger={<Ellipsis size={16} aria-hidden="true" />}
                entries={overflowIndices.map(idx => {
                  const tab = tabs[idx]!;
                  return {
                    id: tab.id,
                    label: tab.label,
                    href: tab.href,
                    count: tab.count,
                    current: tab.id === activeId,
                  };
                })}
                onSelect={
                  onSelect
                    ? entry => {
                        const matched = tabs.find(tab => tab.id === entry.id);
                        if (matched) onSelect(matched);
                      }
                    : undefined
                }
              />
            </Suspense>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
