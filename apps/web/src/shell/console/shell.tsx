// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useRouterState } from "@tanstack/react-router";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { session } from "@console/api";
import { i18n, t } from "@console/i18n";
import { meQuery } from "../../features/account/api";
import { healthStatus, pickLocalized, STATUS_PAGE_URL } from "../../features/health/api/active-status";
import { chunk } from "../../lib/chunk-guard";
import { streamReady } from "../../lib/live/session-stream";
import { useKeys } from "../../lib/react/use-keys";
import { personName } from "../../reference/person/present";
import type { ModuleNavItem } from "../../ui/module-nav/module-nav";
import { PagePhoneHeader } from "../../ui/page/page-scope";
import { openWorkspaceTab, resolveAppHref } from "../../ui/workspace-tabs/open-tab";
import { WorkspaceTabs } from "../../ui/workspace-tabs/workspace-tabs";
import { ShellFrame, type ShellLayoutProps } from "../frame/shell-frame";
import { activeLink, PLATFORM_NAV, TENANT_NAV, type NavLink } from "../nav";
import { ConsoleStatusBar } from "./console-status-bar";
import { ConsoleTopBar } from "./console-top-bar";
import { tabIconForHref } from "./tab-icon";
import { useResolvedTabTitle } from "./tab-titles";
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
  const location = useLocation();
  const pathname = location.pathname;
  const searchStr = location.searchStr ?? "";
  const currentHref = location.href ?? `${pathname}${searchStr}${location.hash ?? ""}`;
  const navigate = useNavigate();
  const isPhone = useSyncExternalStore(subscribePhoneQuery, getPhoneSnapshot, () => false);
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale, () => i18n.locale);
  const noticesActive = !platform && !restoring && Boolean(session.token);
  const notices = useSyncExternalStore(healthStatus.subscribe, healthStatus.get, healthStatus.get);
  useEffect(() => healthStatus.mount(noticesActive), [noticesActive]);
  const showOutage = noticesActive && notices.outage !== null;
  const showStale = noticesActive && notices.stale;
  // The count is a read like the frame's own: it waits for the session's event stream, so the stream opens first.
  const stream = useSyncExternalStore(streamReady.subscribe, streamReady.get);
  const { inboxCount, inboxExact, inboxName, inboxDescription, approvalsCount } = useConsoleCounts(noticesActive && stream);
  // Watches the frame's own read of the reader without sending it again.
  const profileRead = useQuery({ ...meQuery, enabled: false });

  const allLinks: readonly NavLink[] = useMemo(() => menu?.flatMap(group => group.links) ?? [], [menu]);
  const showMyDesk = !platform && tenantPhase !== "SETUP" && userProfile?.employee_link_status === "LINKED";
  const currentModuleTo = useMemo(
    () =>
      (showMyDesk && (pathname === "/me/desk" || pathname.startsWith("/me/"))
        ? "/me/desk"
        : undefined) ??
      activeLink(pathname, allLinks) ??
      (pathname === "/" && allLinks.some(l => l.to === "/") ? "/" : undefined),
    [pathname, allLinks, showMyDesk],
  );

  const navItems: readonly ModuleNavItem[] = useMemo(() => {
    const base = allLinks.map(link =>
      link.countKey === "inbox"
        ? { id: link.to, href: link.to, label: t(link.label), count: inboxCount, countMore: !inboxExact, name: inboxName, description: inboxDescription }
        : { id: link.to, href: link.to, label: t(link.label), count: link.countKey === "approvals" ? approvalsCount : undefined },
    );
    return showMyDesk ? [...base, { id: "/me/desk", href: "/me/desk", label: t("shell.link.meDesk") }] : base;
  }, [allLinks, inboxCount, inboxExact, inboxName, inboxDescription, approvalsCount, showMyDesk]);

  const { title: currentTitle, isFallback, tabTarget } = useResolvedTabTitle({
    pathname,
    searchStr,
    allLinks,
    platform,
  });

  const defaultHref = platform ? "/platform" : "/";
  const defaultLabel = platform ? t("shell.link.tenants") : t("shell.link.todo");
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
    pathname: tabTarget,
    currentHref,
    pathLabel: currentTitle,
    isFallbackLabel: isFallback,
    onNavigate: navigateToHref,
  });

  // A record tab shows a stand-in title until the record's own lands with the screen's first answer. It is settled once
  // the screen stops reading (a refused record never names it), and stays settled for that tab while background reads
  // come and go.
  const reads = useIsFetching({ type: "active" });
  const routing = useRouterState({ select: state => state.status === "pending" });
  const screenReading = reads > 0 || routing;
  const [titleSettled, setTitleSettled] = useState<string>();
  if (!isFallback && titleSettled !== tabTarget) setTitleSettled(tabTarget);
  // Checked a frame after the screen's own reads have started, which happens after this render.
  useEffect(() => {
    if (screenReading || titleSettled === tabTarget) return;
    const frame = requestAnimationFrame(() => setTitleSettled(tabTarget));
    return () => cancelAnimationFrame(frame);
  }, [screenReading, titleSettled, tabTarget]);
  const titlePending = isFallback && titleSettled !== tabTarget;

  // A tab's icon comes from the nav table, not the reader's menu, so the tab keeps its width when the menu lands.
  const tabsWithIcons = useMemo(() => {
    const iconLinks = (platform ? PLATFORM_NAV : TENANT_NAV).flatMap(group => group.links);
    return workspaceTabs.tabs.map(tab => ({
      ...tab,
      icon: tabIconForHref(tab.href, iconLinks),
      pending: titlePending && tab.id === workspaceTabs.activeId && tab.label === currentTitle,
    }));
  }, [workspaceTabs.tabs, workspaceTabs.activeId, platform, titlePending, currentTitle]);

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
  const phoneActiveId = pathname === "/leave" || pathname === "/payslips"
    ? pathname
    : phoneHeader?.phoneNav === "self-service" && pathname === "/account" && location.search.sheet === "certificates"
      ? "/account?sheet=certificates"
      : pathname === "/me/attendance" || pathname === "/me/desk" || pathname === "/me/dispatch-offers" || pathname === "/account" || pathname.startsWith("/account/")
        ? "/account"
        : currentModuleTo;
  const shellOwnsH1 = isPhone && Boolean(phoneHeader?.shellOwnsH1);
  const phoneHeaderValue = useMemo(() => ({ shellOwnsH1 }), [shellOwnsH1]);
  // An empty bar holds each bar's room while the session restores and while the bars' code loads, so the page does not
  // move when they draw. The top one is the page's banner, busy, as the desk bar is while it holds.
  const topHold = <header className={s.phoneTopHold} data-surface="chrome" aria-busy="true" />;
  const navHold = <div className={s.phoneNavHold} />;
  // My profile alone would span the bottom bar until the menu lands, then jump to its own slot. It stays reachable while
  // the menu is away, in the last of the bar's five places, and keeps that place if the menu's read fails.
  const menuAway = !platform && navigationState !== "ready" && phoneHeader?.phoneNav !== "self-service";
  // With a session, a desktop bar draws once the reader's own read has settled too: the tenant's name sets the brand's
  // width, and the scope chip, the nav and the status segments sit after it.
  const holding = restoring || (!platform && Boolean(session.token) && profileRead.isPending);

  return (
    <PagePhoneHeader value={phoneHeaderValue}>
      <div className={s.shell} data-console-shell="">
        {!isPhone ? (
          <>
            <ConsoleTopBar
              platform={platform}
              restoring={holding}
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
            <div className={s.tabsArea}>
              {/* Tabs need nothing from the reader's own read, so they wait only for the session. */}
              {!restoring ? (
                <WorkspaceTabs
                  tabs={tabsWithIcons}
                  activeId={workspaceTabs.activeId}
                  onSelect={workspaceTabs.selectTab}
                  onClose={workspaceTabs.closeTab}
                  onAdd={() => openWorkspaceTab({ href: defaultHref, label: defaultLabel })}
                  renderLink={(tab, props) => (
                    <Link
                      to={tab.href}
                      activeOptions={{ exact: true, includeSearch: true }}
                      activeProps={() => ({})}
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
              ) : null}
            </div>
          </>
        ) : restoring ? (
          <div className={s.phoneTop} data-pinned-bar>{topHold}</div>
        ) : (
          <>
            <div className={s.phoneTop} data-pinned-bar>
              <Suspense fallback={topHold}>
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
            {/* The menu's own failure, with its retry, beside the bar as on a desktop. */}
            {navigationNotice ? <div className={s.phoneNotice}>{navigationNotice}</div> : null}
          </>
        )}

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
            {!holding ? (
              <ConsoleStatusBar
                platform={platform}
                tenantName={tenantName}
                currentTitle={currentTitle}
                inboxCount={inboxCount}
                inboxExact={inboxExact}
              />
            ) : null}
          </div>
        ) : restoring ? (
          <div className={s.phoneNav} data-pinned-bar>{navHold}</div>
        ) : (
          <div className={s.phoneNav} data-pinned-bar>
            <Suspense fallback={navHold}>
              <ConsolePhoneBottom
                links={allLinks}
                inboxCount={inboxCount}
                inboxExact={inboxExact}
                inboxName={inboxName}
                inboxDescription={inboxDescription}
                approvalsCount={approvalsCount}
                platform={platform}
                mode={phoneHeader?.phoneNav}
                unlinked={userProfile?.employee_link_status === "UNLINKED"}
                activeId={phoneActiveId}
                onNavigate={navigateToHref}
                menuAway={menuAway}
              />
            </Suspense>
          </div>
        )}
      </div>
    </PagePhoneHeader>
  );
}
