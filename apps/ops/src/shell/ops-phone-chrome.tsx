// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Menu, Moon, Pause, Play, RefreshCw, Sun, X } from "lucide-react";
import { COPY } from "../copy";
import type { OpsLive } from "../lib/api";
import { fmtJoin, formatCount } from "../lib/format";
import type { LiveStatusSnapshot } from "../lib/live-sse";
import { toggleOpsLocale, useOpsLocale } from "../lib/locale";
import { toggleOpsTheme, useOpsTheme } from "../lib/theme";
import { Badge, type BadgeTone } from "../ui/badge";
import { isNavActive, type OpsNavItem, type OpsQuickLink } from "./nav";
import s from "./ops-shell.module.css";

function liveTone(status: OpsLive): BadgeTone {
  if (status === "Live") return "ok";
  if (status === "Paused") return "info";
  if (status === "Reconnecting") return "warn";
  return "danger";
}

export function OpsPhoneTop({
  liveEnabled,
  live,
  onTogglePause,
  onShowHeld,
  onReconnect,
}: {
  liveEnabled: boolean;
  live: LiveStatusSnapshot;
  onTogglePause: () => void;
  onShowHeld: () => void;
  onReconnect: () => void;
}) {
  const theme = useOpsTheme();
  const locale = useOpsLocale();

  return (
    <header className={s.phoneTop} data-surface="chrome">
      <Link to="/" className={s.phoneBrand}>{COPY.brand}</Link>
      <div className={s.phoneTopTools}>
        {liveEnabled ? (
          <>
            <Badge tone={liveTone(live.status)}>{COPY.live[live.status]}</Badge>
            {live.pendingCount > 0 ? (
              <button type="button" className="btn btn--sm btn--primary" onClick={onShowHeld}>
                <span>{fmtJoin(formatCount(live.pendingCount), " ", COPY.live.showSuffix)}</span>
              </button>
            ) : live.status === "Reconnecting" || live.status === "Offline" ? (
              <button type="button" className="btn btn--sm" onClick={onReconnect} aria-label={COPY.live.retryStream}>
                <RefreshCw size={12} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                onClick={onTogglePause}
                aria-label={live.paused ? COPY.live.resume : COPY.live.pause}
              >
                {live.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
              </button>
            )}
          </>
        ) : null}
        <button
          type="button"
          className="btn btn--sm"
          onClick={toggleOpsLocale}
          aria-label={locale === "ko" ? COPY.locale.labelToEn : COPY.locale.labelToKo}
        >
          <span>{locale === "ko" ? COPY.locale.toggleToEn : COPY.locale.toggleToKo}</span>
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={toggleOpsTheme}
          aria-label={COPY.theme.toggleLabel}
        >
          {theme === "dark" ? <Sun size={12} aria-hidden="true" /> : <Moon size={12} aria-hidden="true" />}
        </button>
      </div>
    </header>
  );
}

export function OpsPhoneBottom({
  navItems,
  subLinks,
  pathname,
  alertsCount,
  alertsUnknown,
}: {
  navItems: readonly OpsNavItem[];
  subLinks: readonly OpsQuickLink[];
  pathname: string;
  alertsCount?: number;
  alertsUnknown?: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  const hasOverflow = navItems.length > 4;
  const visiblePrimary = hasOverflow ? navItems.slice(0, 4) : navItems;
  const overflowPrimary = hasOverflow ? navItems.slice(4) : [];

  useEffect(() => {
    if (!moreOpen) return undefined;
    closeRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setMoreOpen(false);
        moreBtnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  return (
    <>
      {moreOpen ? (
        <div className={s.sheetBackdrop}>
          <button
            type="button"
            className={s.sheetBackdropBtn}
            aria-label={COPY.nav.closeMore}
            onClick={() => {
              setMoreOpen(false);
              moreBtnRef.current?.focus();
            }}
          />
          <div
            className={`${s.moreSheet} overlay`}
            role="dialog"
            aria-modal="true"
            aria-label={COPY.nav.moreSheetTitle}
          >
            <div className={s.sheetHead}>
              <strong className={s.sheetTitle}>{COPY.nav.moreSheetTitle}</strong>
              <button
                ref={closeRef}
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setMoreOpen(false);
                  moreBtnRef.current?.focus();
                }}
                aria-label={COPY.nav.closeMore}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div className={s.sheetGrid}>
              {overflowPrimary.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.id}
                    to={item.to}
                    className={s.sheetLink}
                    aria-current={isNavActive(pathname, item.to) ? "page" : undefined}
                    onClick={() => setMoreOpen(false)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              {subLinks.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.id}
                    to={item.to}
                    className={s.sheetLink}
                    aria-current={pathname === item.to ? "page" : undefined}
                    onClick={() => setMoreOpen(false)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      <nav className={s.phoneBottom} data-surface="chrome" aria-label={COPY.nav.phoneLabel}>
        {visiblePrimary.map((item) => {
          const Icon = item.icon;
          const active = isNavActive(pathname, item.to);
          return (
            <Link
              key={item.id}
              to={item.to}
              className={s.phoneNavLink}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              <span className={s.phoneNavLabel}>
                <span>{item.label}</span>
                {item.id === "alerts" && alertsUnknown ? (
                  <Badge tone="unknown" title={COPY.nav.unknownCountTitle}>
                    {COPY.nav.unknownCountBadge}
                  </Badge>
                ) : item.id === "alerts" && alertsCount !== undefined && alertsCount > 0 ? (
                  <Badge tone="danger">{formatCount(alertsCount)}</Badge>
                ) : null}
              </span>
            </Link>
          );
        })}
        {hasOverflow ? (
          <button
            ref={moreBtnRef}
            type="button"
            className={s.phoneNavBtn}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((prev) => !prev)}
          >
            <Menu size={16} aria-hidden="true" />
            <span className={s.phoneNavLabel}><span>{COPY.nav.more}</span></span>
          </button>
        ) : null}
      </nav>
    </>
  );
}
