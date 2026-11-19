// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { UserRound } from "lucide-react";
import { session } from "@console/api";
import { t } from "@console/i18n";
import { meQuery } from "../../features/account/api";
import { chunk } from "../../lib/chunk-guard";
import { useKeys } from "../../lib/react/use-keys";
import { personName } from "../../reference/person/present";
import { Kbd } from "../../ui/kbd/kbd";
import type { ModuleNavItem } from "../../ui/module-nav/module-nav";
import { PagePhoneHeader } from "../../ui/page/page-scope";
import type { PhoneNavItem } from "../../ui/phone-bars/phone-bars";
import { StatusBar } from "../../ui/status-bar/status-bar";
import { WorkspaceTabs } from "../../ui/workspace-tabs/workspace-tabs";
import { ShellFrame, type ShellLayoutProps } from "../frame/shell-frame";
import { activeLink, type NavLink } from "../nav";
import { ConsoleTopBar } from "./console-top-bar";
import { useConsoleCounts } from "./use-console-counts";
import { openWorkspaceTab, useWorkspaceTabs } from "./workspace-tabs-state";
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

const ConsolePhoneTop = lazy(() =>
  chunk(import("./console-phone-chrome")).then(m => ({ default: m.ConsolePhoneTop })),
);
const ConsolePhoneBottom = lazy(() =>
  chunk(import("./console-phone-chrome")).then(m => ({ default: m.ConsolePhoneBottom })),
);

export function ConsoleShell(props: { children?: ReactNode; pending?: boolean }) {
  return <ShellFrame layout={ConsoleLayout} {...props} />;
}

function ConsoleLayout({
  children,
  platform,
  restoring,
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
  const active = Boolean(session.token);
  const identity = useQuery({ ...meQuery, enabled: !platform && active && !restoring });
  const { inboxCount, inboxExact, approvalsCount } = useConsoleCounts(!platform && active && !restoring);

  const allLinks: readonly NavLink[] = useMemo(() => menu?.flatMap(group => group.links) ?? [], [menu]);
  const currentModuleTo = useMemo(
    () => activeLink(pathname, allLinks) ?? (pathname === "/" && allLinks.some(l => l.to === "/") ? "/" : undefined),
    [pathname, allLinks],
  );

  const countsByHref = useMemo<Readonly<Record<string, number | undefined>>>(
    () => ({ "/": inboxCount, "/approvals": approvalsCount }),
    [inboxCount, approvalsCount],
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

  const phoneItems: readonly PhoneNavItem[] = useMemo(() => {
    const mapped: PhoneNavItem[] = allLinks.map(link => ({
      id: link.to,
      href: link.to,
      label: t(link.label),
      icon: link.icon,
      count: link.countKey === "inbox" ? inboxCount : link.countKey === "approvals" ? approvalsCount : undefined,
    }));
    if (!platform && !mapped.some(item => item.id === "/account")) {
      mapped.push({ id: "/account", href: "/account", label: t("shell.account"), icon: UserRound });
    }
    return mapped;
  }, [allLinks, inboxCount, approvalsCount, platform]);

  const currentTitle = useMemo(() => {
    if (pathname === "/account" || pathname.startsWith("/account/")) return t("shell.account");
    const matched = allLinks.find(link => link.to === currentModuleTo);
    if (matched) return t(matched.label);
    return platform ? t("shell.link.tenants") : t("shell.link.home");
  }, [pathname, allLinks, currentModuleTo, platform]);

  const defaultHref = platform ? "/platform" : "/";
  const defaultLabel = platform ? t("shell.link.tenants") : t("shell.link.home");
  const navigateToHref = useCallback((href: string) => void navigate({ to: href }), [navigate]);

  const workspaceTabs = useWorkspaceTabs({
    principal: session.principal,
    defaultHref,
    defaultLabel,
    pathname,
    pathLabel: currentTitle,
    countsByHref,
    onNavigate: navigateToHref,
  });

  useKeys({
    "shell.search": event => {
      if (platform || event.defaultPrevented) return;
      const mainEl = document.getElementById("main");
      const inPageFind = mainEl?.querySelector<HTMLInputElement>('[data-list-find] input, input[type="search"]');
      if (inPageFind && inPageFind.offsetParent !== null) {
        inPageFind.focus();
        inPageFind.select();
        return;
      }
      onSearch();
    },
  });

  const tenantName = identity.data?.tenant?.name;
  const tenantPhase = identity.data?.tenant?.phase;
  const displayName = personName(
    claims?.name,
    t(claims?.platform ? "account.name.unset.operator" : "account.name.unset"),
  );
  const phoneActiveId = pathname === "/account" || pathname.startsWith("/account/") ? "/account" : currentModuleTo;

  const statusSegments = useMemo(() => {
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
  }, [platform, tenantName, currentTitle, inboxCount, inboxExact]);

  return (
    <PagePhoneHeader value={{ shellOwnsH1: isPhone && Boolean(phoneHeader?.shellOwnsH1) }}>
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
                  tabs={workspaceTabs.tabs}
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
                platform={platform}
                displayName={displayName}
                onSearch={onSearch}
              />
            </Suspense>
          </div>
        ) : null}

        {children}

        {!isPhone ? (
          <div className={s.statusArea}>
            {!restoring ? (
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
            ) : null}
          </div>
        ) : !restoring ? (
          <div className={s.phoneNav}>
            <Suspense fallback={null}>
              <ConsolePhoneBottom items={phoneItems} activeId={phoneActiveId} onNavigate={navigateToHref} />
            </Suspense>
          </div>
        ) : null}
      </div>
    </PagePhoneHeader>
  );
}
