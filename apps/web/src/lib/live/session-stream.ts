// SPDX-License-Identifier: LicenseRef-Proprietary
import type { QueryClient } from "@tanstack/react-query";
import { chunk, crashed } from "../chunk-guard";

let pending: Promise<void> | undefined;

/** Screen loaders wait for the current principal's stream, including a replacement during the chunk load. */
export async function streamReady() {
  while (pending) {
    const loading = pending;
    await loading;
    if (loading === pending) return;
  }
}

/** Load the event client only for an active session; a late chunk cannot reopen a superseded session. */
export function sessionStream(qc: QueryClient) {
  let live: typeof import("./live") | undefined;
  let revision = 0;
  return (active: boolean) => {
    const current = ++revision;
    pending = undefined;
    if (!active) return live?.closeLive();
    if (live) return live.openLive(qc);
    pending = chunk(import("./live")).then(module => {
      live = module;
      if (current === revision) live.openLive(qc);
    });
    void pending.catch(crashed);
  };
}
