/** ASCII digits of `s`; full-width digits count. */
export const digits = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "");

/**
 * Where the caret goes after reformatting: right after the same count of digits that preceded it in the
 * raw input, so typing or deleting mid-value never throws the caret to the end.
 */
export function caretAfter(formatted: string, digitsBefore: number) {
  if (digitsBefore <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) if (/\d/.test(formatted[i]!) && ++seen === digitsBefore) return i + 1;
  return formatted.length;
}
