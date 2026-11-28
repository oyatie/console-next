// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { COPY } from "../copy";
import { fetchOpsMe, opsQueryKeys } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import type { LiveStatusSnapshot } from "../lib/live-sse";
import { useOpsLocale } from "../lib/locale";
import { OpsContext } from "../lib/ops-context";
import { opsLiveController } from "../lib/runtime";
import { OpsShell } from "../shell/ops-shell";
import { O0State } from "../ui/o0-state";
import { PageHead } from "../ui/page-head";

const DEFAULT_LIVE: LiveStatusSnapshot = {
  status: "Live",
  paused: false,
  pendingCount: 0,
  lastEventAt: null,
  disconnectedSince: null,
  disconnectedAgeS: 0,
};

export function OpsRootLayout() {
  const locale = useOpsLocale();
  const [evaluatedAt, setEvaluatedAt] = useState<string | undefined>(undefined);
  const reportEvaluatedAt = useCallback((iso: string) => {
    setEvaluatedAt((prev) => (prev === iso ? prev : iso));
  }, []);

  const controllerLive = useSyncExternalStore(
    opsLiveController.subscribe,
    opsLiveController.getSnapshot,
    () => DEFAULT_LIVE,
  );

  const meQuery = useQuery({
    queryKey: opsQueryKeys.me,
    queryFn: fetchOpsMe,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const canHome = hasOpsAction(meQuery.data, "read.home");
  const live = canHome ? controllerLive : DEFAULT_LIVE;

  const ctxValue = useMemo(
    () => (meQuery.data ? { me: meQuery.data, live, reportEvaluatedAt } : null),
    [meQuery.data, live, reportEvaluatedAt],
  );

  if (meQuery.isPending) {
    return (
      <OpsShell evaluatedAt={undefined}>
        <PageHead title={COPY.brand} meta={COPY.loading.verifyingAccess} />
      </OpsShell>
    );
  }

  if (meQuery.isError || !meQuery.data || !ctxValue) {
    return (
      <OpsShell evaluatedAt={undefined}>
        <O0State model={classifyOpsError(meQuery.error)} onRetry={() => void meQuery.refetch()} />
      </OpsShell>
    );
  }

  return (
    <OpsContext.Provider value={ctxValue}>
      <OpsShell
        me={meQuery.data}
        evaluatedAt={evaluatedAt ?? meQuery.data.evaluated_at}
        liveController={canHome ? opsLiveController : undefined}
      >
        <Outlet key={locale} />
      </OpsShell>
    </OpsContext.Provider>
  );
}
