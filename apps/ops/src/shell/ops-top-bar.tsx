// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { Moon, Pause, Play, RefreshCw, Sun, Terminal } from "lucide-react";
import { COPY } from "../copy";
import type { OpsLive } from "../lib/api";
import type { LiveStatusSnapshot } from "../lib/live-sse";
import { fmtJoin, formatCount } from "../lib/format";
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

export function OpsTopBar({
  liveEnabled,
  navItems,
  pathname,
  alertsCount,
  alertsUnknown,
  displayEmail,
  live,
  onTogglePause,
  onShowHeld,
  onReconnect,
}: {
  liveEnabled: boolean;
  navItems: readonly OpsNavItem[];
  pathname: string;
  alertsCount?: number;
  alertsUnknown?: boolean;
  displayEmail?: string;
  live: LiveStatusSnapshot;
  onTogglePause: () => void;
  onShowHeld: () => void;
  onReconnect: () => void;
}) {
  const theme = useOpsTheme();

  return (
    <header className={s.topbar} data-surface="chrome">
      <Link to="/" className={s.brand}>
        <span className={s.brandMark} aria-hidden="true">
          <Terminal size={13} />
        </span>
        <span>{COPY.brand}</span>
      </Link>
      <span className={s.envChip}>{COPY.envChip}</span>

      <nav className={s.navWrap} aria-label={COPY.nav.label}>
        <ul className={s.navList}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isNavActive(pathname, item.to);
            return (
              <li key={item.id} className={s.navItem}>
                <Link
                  to={item.to}
                  className={s.navLink}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.id === "alerts" && alertsUnknown ? (
                    <Badge tone="unknown" title={COPY.nav.unknownCountTitle}>
                      {COPY.nav.unknownCountBadge}
                    </Badge>
                  ) : item.id === "alerts" && alertsCount !== undefined && alertsCount > 0 ? (
                    <Badge tone="danger">{formatCount(alertsCount)}</Badge>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={s.metaCluster}>
        {liveEnabled ? (
          <div className={s.liveCluster}>
            <Badge tone={liveTone(live.status)}>{COPY.live[live.status]}</Badge>
            {live.status === "Reconnecting" || live.status === "Offline" ? (
              <button type="button" className="btn btn--sm" onClick={onReconnect}>
                <RefreshCw size={12} aria-hidden="true" />
                <span>{COPY.live.retryStream}</span>
              </button>
            ) : (
              <button type="button" className="btn btn--sm" onClick={onTogglePause}>
                {live.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
                <span>{live.paused ? COPY.live.resume : COPY.live.pause}</span>
              </button>
            )}
            {live.pendingCount > 0 ? (
              <button type="button" className="btn btn--sm btn--primary" onClick={onShowHeld}>
                <span>{fmtJoin(formatCount(live.pendingCount), " ", COPY.live.showSuffix)}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn--sm"
          onClick={toggleOpsTheme}
          aria-label={COPY.theme.toggleLabel}
        >
          {theme === "dark" ? <Sun size={12} aria-hidden="true" /> : <Moon size={12} aria-hidden="true" />}
          <span>{theme === "dark" ? COPY.theme.light : COPY.theme.dark}</span>
        </button>

        {displayEmail ? <span className={s.operator}>{displayEmail}</span> : null}
      </div>
    </header>
  );
}
