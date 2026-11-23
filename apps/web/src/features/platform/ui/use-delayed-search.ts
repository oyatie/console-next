// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
import { t } from "@console/i18n";
import { announce } from "../../../lib/react/announce";

/** Debounces search query updates to URL search params and announces match counts after typing pauses. */
export function useDelayedSearch(
  initial: string,
  onSync: (next: string | undefined) => void,
  countFor: (q: string) => number,
) {
  const [q, setQ] = useState(initial);
  const pushed = useRef(initial);
  const syncRef = useRef(onSync);
  const countRef = useRef(countFor);

  useEffect(() => {
    syncRef.current = onSync;
    countRef.current = countFor;
  });

  useEffect(() => {
    if (initial === pushed.current) return;
    pushed.current = initial;
    setQ(initial);
  }, [initial]);

  useEffect(() => {
    const id = setTimeout(() => {
      if (q !== pushed.current) {
        pushed.current = q;
        syncRef.current(q || undefined);
      }
      if (q.trim()) announce(t("tenants.search.count", { count: countRef.current(q) }));
    }, 500);
    return () => clearTimeout(id);
  }, [q]);

  return { q, setQ };
}
