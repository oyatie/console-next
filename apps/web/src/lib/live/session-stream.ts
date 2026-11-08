// SPDX-License-Identifier: LicenseRef-Proprietary
import type { QueryClient } from "@tanstack/react-query";
import { chunk, crashed } from "../chunk-guard";

/** Load the event client only for an active session; a late chunk cannot reopen a superseded session. */
export function sessionStream(qc: QueryClient) {
  let live: typeof import("./live") | undefined;
  let revision = 0;
  return (active: boolean) => {
    const current = ++revision;
    if (!active) return live?.closeLive();
    if (live) return live.openLive(qc);
    void chunk(import("./live")).then(module => {
      live = module;
      if (current === revision) live.openLive(qc);
    }, crashed);
  };
}
