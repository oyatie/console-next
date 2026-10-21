/** The post-start reminder lasts seven elapsed days; a legacy tenant without a start time has no reminder. */
export function phaseBand(phase: string, goLiveAt: string | null | undefined, now: number) {
  if (phase === "SETUP") return "setup";
  if (phase !== "OPERATING" || !goLiveAt) return null;
  const elapsed = now - Date.parse(goLiveAt);
  return elapsed >= 0 && elapsed < 7 * 24 * 60 * 60 * 1000 ? "started" : null;
}
