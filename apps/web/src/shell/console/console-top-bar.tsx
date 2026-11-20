// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { i18n, t } from "@console/i18n";
import { SupportAccessIndicator } from "../../features/support-access/ui/support-access-status";
import { chunk } from "../../lib/chunk-guard";
import { singleKeysOn } from "../../lib/prefs";
import { todayKst } from "../../lib/pure/today";
import { Avatar } from "../../ui/avatar/avatar";
import { Kbd } from "../../ui/kbd/kbd";
import { LiveStatus } from "../../ui/live/live-status";
import { ModuleNavBar, type ModuleNavItem } from "../../ui/module-nav/module-nav";
import { Skeleton } from "../../ui/skeleton/skeleton";
import { TENANT_NAV } from "../nav";
import s from "./shell.module.css";

function ConsoleBrandMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 2V14" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 6H14.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="7.5" y="8" width="5" height="4" rx="0.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

const ConsoleAccountMenu = lazy(() =>
  chunk(import("./console-account-menu")).then(m => ({ default: m.ConsoleAccountMenu })),
);

function formatTodayShort(locale: string): string {
  const iso = todayKst();
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  }).format(parsed);
  return `${iso} (${weekday})`;
}

function ConsoleAccountSlot({
  id,
  name,
  compact = false,
}: {
  id: string;
  name: string;
  compact?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <Link to="/account" className={s.accountBtn} aria-label={name}>
          <Avatar name={name} size="sm" tone="accent" />
          {!compact ? <bdi className={s.accountName}>{name}</bdi> : null}
        </Link>
      }
    >
      <ConsoleAccountMenu id={id} name={name} compact={compact} />
    </Suspense>
  );
}

export function ConsoleTopBar({
  platform,
  restoring,
  defaultHref,
  tenantName,
  tenantPhase,
  navigationState,
  navigationNotice,
  navItems,
  currentModuleTo,
  displayName,
  onNavigate,
  onSearch,
}: {
  platform: boolean;
  restoring: boolean;
  defaultHref: string;
  tenantName?: string;
  tenantPhase?: string;
  navigationState: "loading" | "failed" | "ready";
  navigationNotice: ReactNode;
  navItems: readonly ModuleNavItem[];
  currentModuleTo?: string;
  displayName: string;
  onNavigate: (href: string) => void;
  onSearch: () => void;
}) {
  return (
    <header className={s.top} data-surface="chrome" aria-busy={restoring || undefined}>
      {!restoring ? (
        <>
          <Link to={defaultHref} className={s.brand}>
            <bdi className={s.brandMark} aria-hidden="true">
              <ConsoleBrandMark />
            </bdi>
            <bdi className={s.brandName}>{platform ? t("app.name") : tenantName ?? t("app.name")}</bdi>
            {!platform && tenantPhase === "SETUP" ? (
              <bdi className={s.phaseBadge}>{t("shell.phase.setup")}</bdi>
            ) : null}
          </Link>

          {!platform ? <div className={s.scopeChip}>{t("shell.scope.allEntities")}</div> : null}

          <div className={s.navHost}>
            {!platform && navigationState === "loading" ? (
              <nav aria-label={t("shell.nav")} className={s.navSkeleton}>
                <div className={s.navSkeleton} role="status" aria-busy="true" aria-label={t("common.loading")}>
                  {TENANT_NAV.slice(0, 3).map(group => (
                    <div key={group.hub} className={s.navSkeletonItem}>
                      <Skeleton decorative bones={["line"]} />
                    </div>
                  ))}
                </div>
              </nav>
            ) : navItems.length > 0 ? (
              <ModuleNavBar
                label={t("shell.nav")}
                items={navItems}
                activeId={currentModuleTo}
                onNavigate={item => onNavigate(item.href)}
                renderLink={(item, props) => (
                  <Link
                    to={item.href}
                    className={props.className}
                    activeOptions={{ exact: item.href !== currentModuleTo }}
                    aria-current={props["aria-current"]}
                  >
                    {props.children}
                  </Link>
                )}
              />
            ) : (
              <nav aria-label={t("shell.nav")} />
            )}
            {navigationNotice}
          </div>

          {!platform ? (
            <button
              type="button"
              className={s.searchField}
              onClick={onSearch}
              aria-label={t("shell.jump")}
              aria-keyshortcuts={singleKeysOn() ? "Meta+K Control+K /" : "Meta+K Control+K"}
            >
              <Search size={14} aria-hidden="true" />
              <bdi className={s.searchText}>{t("shell.searchHint")}</bdi>
              <Kbd keys="/" />
            </button>
          ) : null}

          <div className={s.metaCluster}>
            <bdi className={s.dateText}>{formatTodayShort(i18n.locale)}</bdi>
            <LiveStatus />
            {!platform ? <SupportAccessIndicator /> : null}
            <ConsoleAccountSlot id="console-top-account" name={displayName} />
          </div>
        </>
      ) : null}
    </header>
  );
}
