import { useEffect, useRef } from "react";

/** A late receipt may update and focus only the page that started it. */
export function usePageActive() {
  const path = useRef<string | null>(null);
  useEffect(() => {
    path.current = window.location.pathname;
    return () => void (path.current = null);
  }, []);
  return () => path.current === window.location.pathname;
}
