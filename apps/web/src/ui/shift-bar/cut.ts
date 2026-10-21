export type Span = { start: number; end: number };

/** `w` without the parts covered by `by`. */
export function cut(w: Span, by: readonly Span[]): Span[] {
  let parts = [w];
  for (const b of by) parts = parts.flatMap((p) => (b.end <= p.start || b.start >= p.end ? [p] : [{ start: p.start, end: b.start }, { start: b.end, end: p.end }].filter((x) => x.end > x.start)));
  return parts;
}
