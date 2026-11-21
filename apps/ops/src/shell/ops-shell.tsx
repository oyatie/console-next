// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { COPY } from "../copy";
import { fetchOpsAlerts, opsQueryKeys, readObservedValue, type OpsMe } from "../lib/api";
import { hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount } from "../lib/format";
import type { LiveStatusSnapshot, OpsLiveController } from "../lib/live-sse";
import { filterOpsNav, isNavActive } from "./nav";
import { OpsPhoneBottom, OpsPhoneTop } from "./ops-phone-chrome";
import { OpsStatusBar } from "./ops-status-bar";
import { OpsTopBar } from "./ops-top-bar";
import s from "./ops-shell.module.css";

const PHONE_QUERY = "(max-width: 767px)";

function subscribePhoneQuery(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

function getPhoneSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

export function OpsShell({
  me,
  evaluatedAt,
  liveController,
  children,
}: {
  me?: OpsMe;
  evaluatedAt?: string;
  liveController?: OpsLiveController;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const isPhone = useSyncExternalStore(subscribePhoneQuery, getPhoneSnapshot, () => false);
  const canHome = hasOpsAction(me, "read.home");
  const canAlerts = hasOpsAction(me, "read.alerts");
  const activeLiveController = canHome ? liveController : undefined;
  const liveEnabled = Boolean(me && activeLiveController);

  useEffect(() => {
    if (!me || !activeLiveController) return undefined;
    return activeLiveController.start();
  }, [me, activeLiveController]);

  const fallbackLive: LiveStatusSnapshot = useMemo(
    () => ({ status: "Live", paused: false, pendingCount: 0, lastEventAt: null, disconnectedSince: null, disconnectedAgeS: 0 }),
    [],
  );

  const live = useSyncExternalStore(
    activeLiveController ? activeLiveController.subscribe : () => () => {},
    activeLiveController ? activeLiveController.getSnapshot : () => fallbackLive,
    () => fallbackLive,
  );

  const alertsBadgeQuery = useQuery({
    queryKey: opsQueryKeys.alerts({}),
    queryFn: () => fetchOpsAlerts({}),
    enabled: Boolean(me && canAlerts),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const alertsCountObs = alertsBadgeQuery.data?.count;
  const alertsCountVal = readObservedValue(alertsCountObs);
  const alertsUnknown = Boolean(
    canAlerts &&
      alertsBadgeQuery.data &&
      (alertsCountObs?.state === "Unknown" ||
        alertsCountObs?.state === "Stale" ||
        alertsCountVal === null ||
        alertsCountVal === undefined),
  );
  const alertsCount =
    !alertsUnknown && typeof alertsCountVal === "number" ? alertsCountVal : undefined;

  const navItems = useMemo(() => filterOpsNav(me), [me]);
  const currentTitle = useMemo(() => {
    const active = navItems.find((item) => isNavActive(pathname, item.to));
    return active?.label ?? COPY.now.title;
  }, [navItems, pathname]);

  const noticeText =
    live.status === "Paused"
      ? COPY.live.pausedBanner
      : live.status === "Reconnecting"
        ? COPY.live.reconnectBanner
        : live.status === "Offline"
          ? COPY.live.offlineBanner
          : null;

  return (
    <div className={s.shell}>
      <a href="#main" className="skip">{COPY.skipToMain}</a>
      {!isPhone ? (
        <div className={s.topArea}>
          <OpsTopBar
            liveEnabled={liveEnabled}
            navItems={navItems}
            pathname={pathname}
            alertsCount={alertsCount}
            alertsUnknown={alertsUnknown}
            displayEmail={me?.operator.display_email}
            live={live}
            onTogglePause={() => activeLiveController?.togglePause()}
            onShowHeld={() => activeLiveController?.showHeld()}
            onReconnect={() => activeLiveController?.reconnect()}
          />
        </div>
      ) : (
        <div className={s.phoneTopArea}>
          <OpsPhoneTop
            liveEnabled={liveEnabled}
            live={live}
            onTogglePause={() => activeLiveController?.togglePause()}
            onShowHeld={() => activeLiveController?.showHeld()}
            onReconnect={() => activeLiveController?.reconnect()}
          />
        </div>
      )}

      {noticeText ? (
        <div className={s.noticesArea}>
          <div
            className={s.noticeBanner}
            role="status"
            data-tone={live.status === "Offline" ? "danger" : undefined}
          >
            <span>{noticeText}</span>
            {live.pendingCount > 0 ? (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => activeLiveController?.showHeld()}
              >
                <span>{fmtJoin(formatCount(live.pendingCount), " ", COPY.live.showSuffix)}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <main id="main" className={s.main} tabIndex={-1}>
        {children}
      </main>

      {!isPhone ? (
        <div className={s.statusArea}>
          <OpsStatusBar authenticated={Boolean(me)} evaluatedAt={evaluatedAt} currentTitle={currentTitle} live={live} />
        </div>
      ) : navItems.length > 0 ? (
        <div className={s.phoneNavArea}>
          <OpsPhoneBottom
            navItems={navItems}
            pathname={pathname}
            alertsCount={alertsCount}
            alertsUnknown={alertsUnknown}
          />
        </div>
      ) : null}
    </div>
  );
}
