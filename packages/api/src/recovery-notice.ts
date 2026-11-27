// SPDX-License-Identifier: LicenseRef-Proprietary
let cancelled = false;
const listeners = new Set<() => void>();

export function noteCancelledRecovery(next: boolean) {
  if (cancelled === next) return;
  cancelled = next;
  for (const fn of listeners) fn();
}

export const cancelledRecoveryNotice = () => cancelled;
export const dismissCancelledRecoveryNotice = () => noteCancelledRecovery(false);
export const subscribeCancelledRecovery = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
