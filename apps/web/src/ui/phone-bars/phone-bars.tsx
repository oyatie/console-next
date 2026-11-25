// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useId, type ReactNode } from "react";
import { ChevronLeft, Ellipsis, type LucideIcon } from "lucide-react";
import { t } from "@console/i18n";
import { chunk } from "../../lib/chunk-guard";
import { Badge } from "../badge/badge";
import s from "./phone-bars.module.css";

const BarOverflowLinks = lazy(() =>
  chunk(import("../bar-overflow-links")).then(m => ({ default: m.BarOverflowLinks })),
);

type PhoneBackAction = {
  /** Accessible name for the back control (typically `common.back`). */
  label: string;
  /** Optional destination URL when back navigates to a parent route. */
  href?: string;
  /** Optional callback invoked on activation. */
  onBack?: () => void;
};

/**
 * `52px` phone top bar rendered inside `[data-surface="chrome"]`. Displays the screen title, an optional back control,
 * one context fact, and an optional trailing slot while coordinating `<h1>` ownership through `headingAs`.
 */
export function PhoneTopBar({
  title,
  headingAs = "div",
  context,
  back,
  trailing,
}: {
  /** Screen title shown in the phone header. */
  title: ReactNode;
  /** Element used for `title`; set `"h1"` only when enclosed pages shift their own `PageHead` to `<h2>` via `PagePhoneHeader`. */
  headingAs?: "h1" | "div";
  /** Optional single-line context fact (tenant name, person number, or period) aligned to the trailing side. */
  context?: ReactNode;
  /** Optional `44×44` back link or button placed before the title. */
  back?: PhoneBackAction;
  /** Optional trailing controls (such as an account or search trigger). */
  trailing?: ReactNode;
}) {
  const TitleTag = headingAs;
  return (
    <header data-surface="chrome" className={s.topBar} data-has-back={Boolean(back) || undefined}>
      {back ? (
        back.href ? (
          <a
            href={back.href}
            className={s.back}
            aria-label={back.label}
            onClick={
              back.onBack
                ? event => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    back.onBack?.();
                  }
                : undefined
            }
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </a>
        ) : (
          <button type="button" className={s.back} aria-label={back.label} onClick={back.onBack}>
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        )
      ) : null}
      <TitleTag className={s.topTitle}>{title}</TitleTag>
      {context ? <div className={s.topContext}>{context}</div> : null}
      {trailing ? <div className={s.topTrailing}>{trailing}</div> : null}
    </header>
  );
}

export type PhoneNavItem = {
  /** Stable identifier of the phone destination. */
  id: string;
  /** Short translated label shown beneath the icon. */
  label: string;
  /** Destination URL for native link navigation. */
  href: string;
  /** Lucide icon component rendered at `20px` above the label. */
  icon: LucideIcon;
  /** Optional positive count displayed beside the icon. */
  count?: number;
  /** The count is a lower bound, so its badge reads with a plus. */
  countMore?: boolean;
  /** The slot's name when the badge cannot say the count's state (loading, unreadable); it starts with the label. */
  name?: string;
  /** What the count means, read after the name. */
  description?: string;
};

type PhoneNavLinkRenderProps = {
  className: string;
  "aria-current"?: "page";
  "aria-label"?: string;
  "aria-describedby"?: string;
  children: ReactNode;
};

/**
 * `56px` bottom navigation bar for phone viewports, honouring `env(safe-area-inset-bottom)`. Renders up to five slots;
 * when more than five items are passed, the first four render inline and the fifth opens an overflow menu.
 */
export function PhoneBottomNav({
  label,
  items,
  activeId,
  moreLabel,
  onNavigate,
  renderLink,
  reserve,
}: {
  /** Accessible name of the bottom navigation landmark; defaults to `shell.nav`. */
  label?: string;
  /** Ordered destinations available to the signed-in account. */
  items: readonly PhoneNavItem[];
  /** Identifier of the active destination marked with `aria-current="page"`. */
  activeId?: string;
  /** Label for the fifth overflow slot when `items.length > 5`; defaults to `shell.nav.more`. */
  moreLabel?: string;
  /** Invoked when a plain primary click or overflow menu selection activates an item. */
  onNavigate?: (item: PhoneNavItem) => void;
  /** Optional custom link renderer for router integration; falls back to a native `<a>` element. */
  renderLink?: (item: PhoneNavItem, props: PhoneNavLinkRenderProps) => ReactNode;
  /**
   * While the rest of the items are still coming, the bar keeps this many slots' room and draws the items it has in
   * the last of them, so they need not move when the rest arrive.
   */
  reserve?: number;
}) {
  const descriptionId = useId();
  if (items.length === 0) return null;

  const resolvedLabel = label ?? t("shell.nav");
  const resolvedMoreLabel = moreLabel ?? t("shell.nav.more");
  const inlineItems = items.length <= 5 ? items : items.slice(0, 4);
  const overflowItems = items.length <= 5 ? [] : items.slice(4);
  const overflowActive = overflowItems.some(item => item.id === activeId);
  const moreTrigger = (
    <>
      <div className={s.iconRow}>
        <Ellipsis size={20} aria-hidden="true" />
      </div>
      <bdi className={s.label}>{resolvedMoreLabel}</bdi>
    </>
  );

  // The label comes first in the content, so the slot is named label then count as the desk bar is; the icon row is
  // still drawn above it.
  const renderSlotContent = (item: PhoneNavItem) => {
    const Icon = item.icon;
    return (
      <>
        <bdi className={s.label}>{item.label}</bdi>
        <div className={s.iconRow}>
          <Icon size={20} aria-hidden="true" />
          {item.count !== undefined && item.count > 0 ? <Badge count={item.count} more={item.countMore} tone="attention" /> : null}
        </div>
      </>
    );
  };

  return (
    <nav aria-label={resolvedLabel} className={s.bottomNav}>
      <ul
        className={s.list}
        ref={el => el?.style.setProperty("--held", reserve && reserve > items.length ? `${((reserve - items.length) / reserve) * 100}%` : "0%")}
      >
        {inlineItems.map((item, idx) => {
          const isCurrent = item.id === activeId;
          const linkProps: PhoneNavLinkRenderProps = {
            className: s.slot!,
            "aria-current": isCurrent ? "page" : undefined,
            "aria-label": item.name,
            "aria-describedby": item.description ? `${descriptionId}-${idx}` : undefined,
            children: renderSlotContent(item),
          };
          return (
            <li key={item.id} className={s.entry}>
              {renderLink ? (
                renderLink(item, linkProps)
              ) : (
                <a
                  href={item.href}
                  className={linkProps.className}
                  aria-current={linkProps["aria-current"]}
                  aria-label={linkProps["aria-label"]}
                  aria-describedby={linkProps["aria-describedby"]}
                  onClick={
                    onNavigate
                      ? event => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                            return;
                          }
                          event.preventDefault();
                          onNavigate(item);
                        }
                      : undefined
                  }
                >
                  {linkProps.children}
                </a>
              )}
              {item.description ? <bdi id={`${descriptionId}-${idx}`} className="sr-only">{item.description}</bdi> : null}
            </li>
          );
        })}
        {overflowItems.length > 0 ? (
          <li className={s.entry}>
            <Suspense
              fallback={
                <button
                  type="button"
                  className={s.slot!}
                  aria-label={resolvedMoreLabel}
                  aria-expanded={false}
                  data-active={overflowActive || undefined}
                >
                  {moreTrigger}
                </button>
              }
            >
              <BarOverflowLinks
                label={resolvedMoreLabel}
                triggerClassName={s.slot!}
                triggerActive={overflowActive}
                placement="top"
                trigger={moreTrigger}
                entries={overflowItems.map(item => ({
                  id: item.id,
                  label: item.label,
                  href: item.href,
                  count: item.count,
                  current: item.id === activeId,
                }))}
                onSelect={
                  onNavigate
                    ? entry => {
                        const matched = overflowItems.find(item => item.id === entry.id);
                        if (matched) onNavigate(matched);
                      }
                    : undefined
                }
              />
            </Suspense>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
