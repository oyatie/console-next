// Freshness loops (decision #27): data shown as current is re-read only when the event stream says it changed
// (apps/web/src/lib/live), never on a timer or on window focus. check-source runs this over every source file.
//   - `setInterval(` anywhere;
//   - TanStack `refetchInterval` / `refetchIntervalInBackground` with any value but `false`;
//   - `refetchOnWindowFocus` with any value but `false`.
// LOOP_ALLOW holds the files a protocol requires to poll, with the reason. Today it is empty: the one sanctioned
// poll, the desktop device-login poll, lives in apps/desktop, outside these roots. An entry needs owner approval,
// and an entry whose file no longer polls fails (check-source), so the list only shrinks.
export const LOOP_ALLOW = {};

const RULES = [
  [/\bsetInterval\s*\(/g, "setInterval re-reads on a timer"],
  [/\brefetchInterval(?:InBackground)?\b(?!\s*:\s*false\b)/g, "refetchInterval polls"],
  [/\brefetchOnWindowFocus\b(?!\s*:\s*false\b)/g, "refetchOnWindowFocus re-reads on every focus"],
];

/** The loop problems in one source file (empty = pass). */
export function loopProblems(file, src) {
  const out = [];
  for (const [re, why] of RULES)
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push(`${file}:${line}: ${why}; live data comes from the event stream (decision #27, lib/live)`);
    }
  return out;
}
