import { useEffect, useState } from "react";
import { announcementForPathname, useAnnouncerRoute, type Speak } from "../lib/react/announce";

/** The one polite live region; rendered once by the shell, which binds `announce` to it. */
export function Announcer({ bind }: { bind: (say: Speak) => () => void }) {
  const { pathname, router } = useAnnouncerRoute();
  const [entry, setEntry] = useState<{ text: string; pathname: string } | null>(null);
  // Clear first so the same text twice in a row is still announced; clear when the route pathname moves.
  useEffect(() => {
    let receiptPath: string | undefined;
    const unbind = bind((text, source) => {
      const at = router.state.location.pathname;
      // A delayed heading read must not replace the receipt for the action that opened this page.
      if (source === "route" && receiptPath === at) {
        receiptPath = undefined;
        return;
      }
      receiptPath = source === "route" ? undefined : at;
      setEntry(null);
      requestAnimationFrame(() => setEntry({ text, pathname: at }));
    });
    const unsub = router.subscribe("onResolved", ({ toLocation }) => {
      if (receiptPath !== toLocation.pathname) receiptPath = undefined;
      setEntry((prev) => (prev && prev.pathname !== toLocation.pathname ? null : prev));
    });
    return () => {
      unbind();
      unsub();
    };
  }, [bind, router]);
  return <div role="status" className="sr-only">{announcementForPathname(entry, pathname)}</div>;
}
