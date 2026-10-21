// The options a choice column of the correction grid edits through (r3:records-17), narrowed by what is typed. Pure.

/** The options the typed text narrows to (all of them for nothing typed); spaces never count. */
export function narrow(words: readonly string[], text: string): readonly string[] {
  const q = text.replace(/\s/g, "");
  return words.filter((w) => !q || w.replace(/\s/g, "").includes(q));
}
