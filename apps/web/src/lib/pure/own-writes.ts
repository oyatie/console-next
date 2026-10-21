/**
 * The versions this tab's own corrections produced, per record (`from` → `to`, the fields written). The server's
 * precondition is the whole record's `expected_updated_at` (409 when stale), so a command read before the user's own
 * earlier write landed in the cache (a photo pressed while the contact delete still refetches) is refused against that
 * write. A step the user made on other fields is skipped (docs/design/concurrent-editing.md ME-6: a conflict only when the
 * same field changed); a step on the same field, or any change this tab did not make, still goes to the server stale and
 * is refused there, so nothing anyone else saved is overwritten.
 */
export function ownWrites(limit = 32) {
  const steps = new Map<string, { from: string; to: string; fields: readonly string[] }[]>();
  return {
    /** The newest version reachable from `base` through this tab's writes to fields other than `fields`. */
    base(id: string, base: string, fields: readonly string[]) {
      let v = base;
      for (let s = steps.get(id)?.find((x) => x.from === v); s && !s.fields.some((f) => fields.includes(f)); s = steps.get(id)?.find((x) => x.from === v)) v = s.to;
      return v;
    },
    /** A write this tab sent at `from` that the server answered with `to`. */
    record(id: string, from: string, to: string, fields: readonly string[]) {
      if (from === to) return;
      steps.set(id, [...(steps.get(id) ?? []), { from, to, fields }].slice(-limit));
    },
  };
}
