// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useId, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { i18n, t } from "@console/i18n";
import { SupportAccessIndicator } from "../../features/support-access/ui/support-access-status";
import { chunk } from "../../lib/chunk-guard";
import { todayKst } from "../../lib/pure/today";
import { useSingleKeys } from "../../lib/react/use-single-keys";
import { Avatar } from "../../ui/avatar/avatar";
import { Kbd } from "../../ui/kbd/kbd";
import { ModuleNavBar, type ModuleNavItem } from "../../ui/module-nav/module-nav";
import { Skeleton } from "../../ui/skeleton/skeleton";
import { TENANT_NAV } from "../nav";
import s from "./shell.module.css";

function ConsoleBrandMark() {
  return (
    <svg className={s.brandMark} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1.25" y="1.25" width="15.5" height="15.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.25 6.5h15.5M6.5 6.5v10.25" stroke="currentColor" strokeWidth="1.5" />
      <rect className={s.brandSquare} x="9.5" y="9.5" width="4.5" height="4.5" />
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
        <Link to="/account" className={s.accountBtn} aria-label={compact ? name : undefined}>
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
  const singleKeys = useSingleKeys();
  const searchId = useId();
  return (
    <header className={s.top} data-surface="chrome" aria-busy={restoring || undefined}>
      {!restoring ? (
        <>
          <Link to={defaultHref} className={s.brand}>
            <ConsoleBrandMark />
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
                    aria-label={props["aria-label"]}
                    aria-describedby={props["aria-describedby"]}
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
            // Named as the phone bar and the palette name it, then by the hint it shows, so a spoken hint reaches it.
            <button
              type="button"
              className={s.searchField}
              onClick={onSearch}
              aria-labelledby={`${searchId}-name ${searchId}-hint`}
              aria-haspopup="dialog"
              aria-keyshortcuts={singleKeys ? "Meta+K Control+K /" : "Meta+K Control+K"}
            >
              <Search size={14} aria-hidden="true" />
              <span id={`${searchId}-name`} className="sr-only">{t("shell.jumpLabel")}</span>
              <bdi id={`${searchId}-hint`} className={s.searchText}>{t("shell.searchHint")}</bdi>
              {singleKeys && <Kbd keys="/" />}
            </button>
          ) : null}

          <div className={s.metaCluster}>
            <bdi className={s.dateText}>{formatTodayShort(i18n.locale)}</bdi>
            {!platform ? <SupportAccessIndicator /> : null}
            <ConsoleAccountSlot id="console-top-account" name={displayName} />
          </div>
        </>
      ) : null}
    </header>
  );
}
