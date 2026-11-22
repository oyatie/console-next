// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import type { OpsLive } from "../lib/api";
import { fmtJoin, formatDuration } from "../lib/format";

export function isLiveDisconnected(liveStatus: OpsLive): boolean {
  return liveStatus === "Reconnecting" || liveStatus === "Offline";
}

export function getStaleClientTag(liveStatus: OpsLive, disconnectedAgeS: number): string {
  if (liveStatus === "Offline") {
    return fmtJoin(COPY.observed.unknownPrefix, COPY.live.offlineClientReason);
  }
  const disconnectedAge = disconnectedAgeS > 0 ? formatDuration(disconnectedAgeS) : "";
  return disconnectedAge
    ? fmtJoin(COPY.observed.staleValuePrefix, disconnectedAge)
    : fmtJoin(COPY.observed.unknownPrefix, COPY.live.staleClientReason);
}
