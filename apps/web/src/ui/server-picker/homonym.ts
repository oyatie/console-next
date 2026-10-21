// Namesakes in a server result: choosing one of several people with the same name needs the last digits of the
// chosen person's code, so a namesake is never picked by habit (C-05). Plain TS, tested in homonym.test.ts.

/** How many trailing characters of the code confirm a namesake (the h1plus picker design). */
export const SUFFIX = 4;

type Named = { id: string; name: string; code?: string };

/** Every option sharing the chosen one's name (including it), or [] when nothing is chosen. */
export const homonymOf = <O extends Named>(options: readonly O[], chosen: O | undefined): O[] =>
  chosen ? options.filter((o) => o.name.trim() === chosen.name.trim()) : [];

/** The typed text equals the chosen code's last SUFFIX characters (case-insensitive, spaces ignored). */
export const suffixMatches = (chosen: Named, typed: string) => {
  const want = (chosen.code ?? "").slice(-SUFFIX).toLowerCase();
  return want.length === SUFFIX && typed.replace(/\s/g, "").toLowerCase() === want;
};
