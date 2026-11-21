// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { CalendarDays, Settings } from "lucide-react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { session } from "@console/api";
import { i18n, t } from "@console/i18n";
import { healthStatus, pickLocalized, STATUS_PAGE_URL } from "../../features/health/api/active-status";
import { chunk } from "../../lib/chunk-guard";
import { useKeys } from "../../lib/react/use-keys";
import { personName } from "../../reference/person/present";
import { Kbd } from "../../ui/kbd/kbd";
import type { ModuleNavItem } from "../../ui/module-nav/module-nav";
import { PagePhoneHeader } from "../../ui/page/page-scope";
import { StatusBar } from "../../ui/status-bar/status-bar";
import { usePublishedStatusBar } from "../../ui/status-bar/status-bar-store";
import { openWorkspaceTab, resolveAppHref } from "../../ui/workspace-tabs/open-tab";
import { WorkspaceTabs } from "../../ui/workspace-tabs/workspace-tabs";
import { ShellFrame, type ShellLayoutProps } from "../frame/shell-frame";
import { activeLink, type NavLink } from "../nav";
import { ConsoleTopBar } from "./console-top-bar";
import { useConsoleCounts } from "./use-console-counts";
import { useWorkspaceTabs } from "./workspace-tabs-state";
import s from "./shell.module.css";

const PHONE_QUERY = "(max-width: 767px)";

function subscribePhoneQuery(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function getPhoneSnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

const ConsolePhoneTop = lazy(() => chunk(import("./console-phone-chrome")).then(m => ({ default: m.ConsolePhoneTop })));
const ConsolePhoneBottom = lazy(() => chunk(import("./console-phone-chrome")).then(m => ({ default: m.ConsolePhoneBottom })));
const OutageBanner = lazy(() => chunk(import("../../ui/live/outage-banner")).then(m => ({ default: m.OutageBanner })));
const StalenessBar = lazy(() => chunk(import("../../ui/live/staleness-bar")).then(m => ({ default: m.StalenessBar })));

function tabIconForHref(href: string, allLinks: readonly NavLink[]): ReactNode {
  const cut = href.search(/[?#]/);
  const path = (cut === -1 ? href : href.slice(0, cut)) || "/";
  if (path === "/leave") {
    return <CalendarDays size={14} aria-hidden="true" />;
  }
  if (path === "/account" || path.startsWith("/account/")) {
    return <Settings size={14} aria-hidden="true" />;
  }
  const matchedHref = path === "/" || path === "/inbox" ? "/" : activeLink(path, allLinks);
  const Icon =
    (matchedHref ? allLinks.find(link => link.to === matchedHref)?.icon : undefined) ??
    allLinks[0]?.icon;
  return Icon ? <Icon size={14} aria-hidden="true" /> : null;
}

export function ConsoleShell(props: { children?: ReactNode; pending?: boolean }) {
  return <ShellFrame layout={ConsoleLayout} {...props} />;
}

function ConsoleLayout({
  children,
  platform,
  restoring,
  tenantName,
  tenantPhase,
  userProfile,
  menu,
  navigationState,
  navigationNotice,
  onSearch,
  phoneHeader,
}: ShellLayoutProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isPhone = useSyncExternalStore(subscribePhoneQuery, getPhoneSnapshot, () => false);
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale, () => i18n.locale);
  const noticesActive = !platform && !restoring && Boolean(session.token);
  const notices = useSyncExternalStore(healthStatus.subscribe, healthStatus.get, healthStatus.get);
  useEffect(() => healthStatus.mount(noticesActive), [noticesActive]);
  const showOutage = noticesActive && notices.outage !== null;
  const showStale = noticesActive && notices.stale;
  const { inboxCount, inboxExact, approvalsCount } = useConsoleCounts(noticesActive);

  const allLinks: readonly NavLink[] = useMemo(() => menu?.flatMap(group => group.links) ?? [], [menu]);
  const currentModuleTo = useMemo(
    () => activeLink(pathname, allLinks) ?? (pathname === "/" && allLinks.some(l => l.to === "/") ? "/" : undefined),
    [pathname, allLinks],
  );

  const navItems: readonly ModuleNavItem[] = useMemo(
    () =>
      allLinks.map(link => ({
        id: link.to,
        href: link.to,
        label: t(link.label),
        count: link.countKey === "inbox" ? inboxCount : link.countKey === "approvals" ? approvalsCount : undefined,
      })),
    [allLinks, inboxCount, approvalsCount],
  );

  const currentTitle = useMemo(() => {
    if (pathname === "/leave") return t("leave.title");
    if (pathname === "/account" || pathname.startsWith("/account/")) return t("shell.account");
    const matched = allLinks.find(link => link.to === currentModuleTo);
    if (matched) return t(matched.label);
    return platform ? t("shell.link.tenants") : t("shell.link.home");
  }, [pathname, allLinks, currentModuleTo, platform]);

  const defaultHref = platform ? "/platform" : "/";
  const defaultLabel = platform ? t("shell.link.tenants") : t("shell.link.home");
  const navigateToHref = useCallback(
    (href: string) => {
      const resolved = resolveAppHref(href, pathname);
      if (resolved) void navigate({ href: resolved });
    },
    [navigate, pathname],
  );

  const workspaceTabs = useWorkspaceTabs({
    principal: session.principal,
    defaultHref,
    defaultLabel,
    pathname,
    pathLabel: currentTitle,
    onNavigate: navigateToHref,
  });

  const tabsWithIcons = useMemo(
    () =>
      workspaceTabs.tabs.map(tab => ({
        ...tab,
        icon: tabIconForHref(tab.href, allLinks),
      })),
    [workspaceTabs.tabs, allLinks],
  );

  useKeys(
    platform
      ? {}
      : {
          "shell.search": () => {
            const mainEl = document.getElementById("main");
            const inPageFind = mainEl?.querySelector<HTMLInputElement>('[data-list-find] input, input[type="search"]');
            if (inPageFind && inPageFind.offsetParent !== null) {
              inPageFind.focus();
              inPageFind.select();
              return;
            }
            onSearch();
          },
        },
  );

  const rawName = (userProfile?.display_name?.trim() || claims?.name?.trim()) ?? "";
  const shortName = personName(
    rawName,
    t(claims?.platform ? "account.name.unset.operator" : "account.name.unset"),
  );
  const roleMeta = [userProfile?.employee_org_unit, userProfile?.employee_position]
    .map(part => part?.trim())
    .filter(Boolean)
    .join(" ");
  const displayName = rawName && roleMeta ? `${shortName} · ${roleMeta}` : shortName;
  const phoneActiveId = pathname === "/leave"
    ? "/leave"
    : pathname === "/account" || pathname.startsWith("/account/")
      ? "/account"
      : currentModuleTo;
  const shellOwnsH1 = isPhone && Boolean(phoneHeader?.shellOwnsH1);
  const phoneHeaderValue = useMemo(() => ({ shellOwnsH1 }), [shellOwnsH1]);

  return (
    <PagePhoneHeader value={phoneHeaderValue}>
      <div className={s.shell} data-console-shell="">
        {!isPhone ? (
          <>
            <ConsoleTopBar
              platform={platform}
              restoring={restoring}
              defaultHref={defaultHref}
              tenantName={tenantName}
              tenantPhase={tenantPhase}
              navigationState={navigationState}
              navigationNotice={navigationNotice}
              navItems={navItems}
              currentModuleTo={currentModuleTo}
              displayName={displayName}
              onNavigate={navigateToHref}
              onSearch={onSearch}
            />
            {!restoring ? (
              <div className={s.tabsArea}>
                <WorkspaceTabs
                  tabs={tabsWithIcons}
                  activeId={workspaceTabs.activeId}
                  onSelect={workspaceTabs.selectTab}
                  onClose={workspaceTabs.closeTab}
                  onAdd={() => openWorkspaceTab({ href: defaultHref, label: defaultLabel })}
                  renderLink={(tab, props) => (
                    <Link
                      to={tab.href}
                      className={props.className}
                      aria-current={props["aria-current"]}
                      data-workspace-tab=""
                      onKeyDown={props.onKeyDown}
                      onClick={event => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                          return;
                        }
                        event.preventDefault();
                        workspaceTabs.selectTab(tab);
                      }}
                    >
                      {props.children}
                    </Link>
                  )}
                />
              </div>
            ) : null}
          </>
        ) : !restoring ? (
          <div className={s.phoneTop}>
            <Suspense fallback={null}>
              <ConsolePhoneTop
                title={phoneHeader?.title ?? currentTitle}
                shellOwnsH1={phoneHeader?.shellOwnsH1}
                context={phoneHeader?.context ?? (!platform ? tenantName : undefined)}
                back={phoneHeader?.back}
                hideActions={phoneHeader?.hideActions}
                platform={platform}
                displayName={displayName}
                onSearch={onSearch}
              />
            </Suspense>
          </div>
        ) : null}

        {showOutage || showStale ? (
          <section aria-label={t("live.noticesLabel")} className={s.noticesArea}>
            {showOutage && notices.outage ? (
              <Suspense fallback={null}><OutageBanner severity={notices.outage.severity} title={notices.outage.title ? pickLocalized(notices.outage.title, locale) : null} affected={notices.outage.affected.map(item => pickLocalized(item, locale))} statusPageHref={STATUS_PAGE_URL} retrying={notices.retrying} onRetry={() => void healthStatus.retry()} /></Suspense>
            ) : null}
            {showStale ? <Suspense fallback={null}><StalenessBar lastEventAt={notices.lastEventAt} /></Suspense> : null}
          </section>
        ) : null}

        {children}

        {!isPhone ? (
          <div className={s.statusArea}>
            {!restoring ? (
              <ConsoleStatusBar
                platform={platform}
                tenantName={tenantName}
                currentTitle={currentTitle}
                inboxCount={inboxCount}
                inboxExact={inboxExact}
              />
            ) : null}
          </div>
        ) : !restoring ? (
          <div className={s.phoneNav}>
            <Suspense fallback={null}>
              <ConsolePhoneBottom
                links={allLinks}
                inboxCount={inboxCount}
                approvalsCount={approvalsCount}
                platform={platform}
                mode={phoneHeader?.phoneNav}
                activeId={phoneActiveId}
                onNavigate={navigateToHref}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
    </PagePhoneHeader>
  );
}

function ConsoleStatusBar({ platform, tenantName, currentTitle, inboxCount, inboxExact }: {
  platform?: boolean; tenantName?: string; currentTitle: string; inboxCount?: number; inboxExact: boolean;
}) {
  const publishedSegments = usePublishedStatusBar();
  const statusSegments = useMemo(() => {
    if (publishedSegments && publishedSegments.length > 0) {
      return publishedSegments;
    }
    const segments: { id: string; content: ReactNode; tone?: "default" | "strong" | "attention" }[] = [
      { id: "scope", content: platform ? t("shell.hub.platform") : tenantName ?? t("app.name"), tone: "strong" },
      { id: "module", content: currentTitle },
    ];
    if (!platform && inboxCount !== undefined && inboxCount > 0) {
      segments.push({
        id: "inbox",
        content: t(inboxExact ? "shell.needsMe.count" : "shell.needsMe.countMore", { count: inboxCount }),
        tone: "attention",
      });
    }
    return segments;
  }, [publishedSegments, platform, tenantName, currentTitle, inboxCount, inboxExact]);

  return (
    <StatusBar
      segments={statusSegments}
      trailing={
        !platform ? (
          <>
            <bdi>{t("shell.jumpLabel")}</bdi>
            <Kbd keys={t("shell.jumpKey")} />
          </>
        ) : undefined
      }
    />
  );
}
