/** The post-start reminder lasts seven elapsed days; a legacy tenant without a start time has no reminder. */
export function phaseBand(phase: string, goLiveAt: string | null | undefined, now: number) {
  if (phase === "SETUP") return "setup";
  if (phase !== "OPERATING" || !goLiveAt) return null;
  // OPERATING is authoritative even when the server clock is ahead of this device.
  const elapsed = Math.max(0, now - Date.parse(goLiveAt));
  return elapsed >= 0 && elapsed < 7 * 24 * 60 * 60 * 1000 ? "started" : null;
}
