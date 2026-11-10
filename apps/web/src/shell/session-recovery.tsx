// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { refresh, session } from "@console/api";
import { t } from "@console/i18n";
import { read } from "../lib/query";
import { QueryState } from "../lib/react/query-state";
import { streamReady } from "../lib/live/session-stream";

/** No protected region mounts before restoration and the current principal's stream. */
export function SessionRecovery({ children }: { children: ReactNode }) {
  const router = useRouter();
  const active = useSyncExternalStore(session.subscribe, () => Boolean(session.token || session.lost), () => false);
  const stream = useSyncExternalStore(streamReady.subscribe, streamReady.get, () => false);
  const ready = active && (stream || session.lost);
  const restore = useQuery({
    ...read("/api/v1/auth/token/refresh", async () => {
      if (!(await refresh())) { await router.navigate({ to: "/login" }); return false; }
      await streamReady();
      await router.invalidate();
      return true;
    }),
    enabled: !ready,
    staleTime: 0,
    retry: false,
  });
  return ready ? children : <QueryState q={restore} layout="list" own={() => t("common.read.sessionRestoreReason")}>{() => null}</QueryState>;
}
