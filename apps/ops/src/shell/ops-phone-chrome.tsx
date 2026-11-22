// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { Moon, Pause, Play, RefreshCw, Sun } from "lucide-react";
import { COPY } from "../copy";
import type { OpsLive } from "../lib/api";
import { fmtJoin, formatCount } from "../lib/format";
import type { LiveStatusSnapshot } from "../lib/live-sse";
import { toggleOpsTheme, useOpsTheme } from "../lib/theme";
import { Badge, type BadgeTone } from "../ui/badge";
import { isNavActive, type OpsNavItem } from "./nav";
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
  pathname,
  alertsCount,
  alertsUnknown,
}: {
  navItems: readonly OpsNavItem[];
  pathname: string;
  alertsCount?: number;
  alertsUnknown?: boolean;
}) {
  return (
    <nav className={s.phoneBottom} data-surface="chrome" aria-label={COPY.nav.phoneLabel}>
      {navItems.map((item) => {
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
    </nav>
  );
}
