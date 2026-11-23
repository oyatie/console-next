// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";

export function useDesktopAutoSelect<T>({
  rows,
  getId,
  explicitId,
  onSelectExplicit,
  onClearExplicit,
}: {
  rows: readonly T[];
  getId: (item: T) => string;
  explicitId: string | undefined;
  onSelectExplicit: (id: string) => void;
  onClearExplicit: () => void;
}) {
  const [isDesktop, setIsDesktop] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);

  const effectiveId = explicitId ?? (isDesktop && !dismissed && rows.length > 0 ? getId(rows[0]!) : undefined);

  const select = (id: string) => {
    setDismissed(false);
    onSelectExplicit(id);
  };

  const dismiss = () => {
    setDismissed(true);
    onClearExplicit();
  };

  const resetDismiss = () => setDismissed(false);

  return { effectiveId, select, dismiss, resetDismiss };
}
