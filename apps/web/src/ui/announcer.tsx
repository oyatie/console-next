import { useEffect, useState } from "react";
import { announcementForPathname, useAnnouncerRoute } from "../lib/react/announce";

/** The one polite live region; rendered once by the shell, which binds `announce` to it. */
export function Announcer({ bind }: { bind: (say: (message: string) => void) => () => void }) {
  const { pathname, router } = useAnnouncerRoute();
  const [entry, setEntry] = useState<{ text: string; pathname: string } | null>(null);
  // Clear first so the same text twice in a row is still announced; clear when the route pathname moves.
  useEffect(() => {
    const unbind = bind((text) => {
      const at = router.state.location.pathname;
      setEntry(null);
      requestAnimationFrame(() => setEntry({ text, pathname: at }));
    });
    const unsub = router.subscribe("onResolved", ({ toLocation }) => {
      setEntry((prev) => (prev && prev.pathname !== toLocation.pathname ? null : prev));
    });
    return () => {
      unbind();
      unsub();
    };
  }, [bind, router]);
  return <div role="status" className="sr-only">{announcementForPathname(entry, pathname)}</div>;
}
