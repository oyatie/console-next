// SPDX-License-Identifier: LicenseRef-Proprietary
import type { QueryClient } from "@tanstack/react-query";
import { chunk, crashed } from "../chunk-guard";

let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** Screen loaders wait for the current principal's stream, including a replacement during the chunk load. */
export async function streamReady() {
  while (pending) {
    await pending;
  }
}
streamReady.subscribe = (listener: () => void) => { listeners.add(listener); return () => void listeners.delete(listener); };
streamReady.get = () => !pending;

/** Load the event client only for an active session; a late chunk cannot reopen a superseded session. */
export function sessionStream(qc: QueryClient) {
  let live: typeof import("./live") | undefined;
  let revision = 0;
  return (active: boolean) => {
    const current = ++revision;
    pending = undefined;
    if (!active) live?.closeLive();
    else if (live) live.openLive(qc);
    else {
      pending = chunk(import("./live")).then(module => {
        live = module;
        if (current !== revision) return;
        live.openLive(qc);
        pending = undefined;
        emit();
      }).catch(() => {
        crashed();
        // The static guard owns recovery; keep protected loaders closed until its reload.
        return new Promise<void>(() => {});
      });
    }
    emit();
  };
}
