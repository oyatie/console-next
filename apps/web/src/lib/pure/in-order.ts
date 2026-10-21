/** `items` in the order `order` lists them (the stored legal entity / workplace / department order); what it does not list follows, as given. */
export function inOrder<T>(items: readonly T[], order: readonly T[]): T[] {
  const at = (x: T) => (order.includes(x) ? order.indexOf(x) : order.length);
  return [...items].sort((a, b) => at(a) - at(b));
}
