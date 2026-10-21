import { useEffect } from "react";
import { runExpired } from "../api";

/** Tells the page once a command failed because the run expired (409 import_run_expired): it offers to read the file again. */
export function useExpiry(error: unknown, onExpired: () => void) {
  const expired = runExpired(error);
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, onExpired]);
}
