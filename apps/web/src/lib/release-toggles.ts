// B-15 release toggles: a feature can ship dark in one deploy and be released by configuration in another
// (Fowler, "Feature Toggles": release toggles). The server lists what is released (CONSOLE_RELEASE_TOGGLES) at
// GET /api/v1/release-toggles; unknown names never appear there. Read once, on the first import of this module.
// Plain fetch, not the generated client: unauthenticated, and no schema regen for one tiny read.
let enabled: ReadonlySet<string> = new Set();

/** Resolves once the list is read; on any failure every toggle stays off (the safe side of a release toggle). */
export const releaseTogglesRead: Promise<void> = (async () => {
  try {
    const res = await fetch("/api/v1/release-toggles", { credentials: "omit" });
    const body: unknown = res.ok ? await res.json() : null;
    const names = (body as { enabled?: unknown } | null)?.enabled;
    if (Array.isArray(names)) enabled = new Set(names.filter((n): n is string => typeof n === "string"));
  } catch {
    // Off: an unreachable list never releases a feature.
  }
})();

/** Is this feature released? False until the list is read and whenever it could not be. */
export const released = (name: string) => enabled.has(name);
