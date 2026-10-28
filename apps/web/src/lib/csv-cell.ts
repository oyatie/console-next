// SPDX-License-Identifier: LicenseRef-Proprietary
const FORMULA_PREFIX = /^[=+\-@\t\r\n]/;
const LEADING_IGNORABLE = /^[\p{White_Space}\p{Cc}\p{Cf}\uFEFF]*/u;

function decodePrefix(value: string): string {
  const leading = value.match(LEADING_IGNORABLE)?.[0] ?? "";
  const rest = value.slice(leading.length);
  const percent = rest.match(/^(?:%[0-9a-f]{2})+/i)?.[0];
  if (percent) {
    try {
      return leading + decodeURIComponent(percent) + rest.slice(percent.length);
    } catch {
      return value;
    }
  }
  const entity = rest.match(/^&#(?:x([0-9a-f]+)|(\d+));?/i);
  if (entity) {
    const code = Number.parseInt(entity[1] ?? entity[2]!, entity[1] ? 16 : 10);
    if (Number.isFinite(code) && code <= 0x10ffff) {
      return leading + String.fromCodePoint(code) + rest.slice(entity[0].length);
    }
  }
  const named = rest.match(/^&(equals|plus|minus|commat|tab|newline);/i);
  if (named) {
    const decoded: Record<string, string> = { equals: "=", plus: "+", minus: "-", commat: "@", tab: "\t", newline: "\n" };
    return leading + decoded[named[1]!.toLowerCase()] + rest.slice(named[0].length);
  }
  const escaped = rest.match(/^\\(?:u([0-9a-f]{4})|x([0-9a-f]{2}))/i);
  if (escaped) {
    const code = Number.parseInt(escaped[1] ?? escaped[2]!, 16);
    return leading + String.fromCodePoint(code) + rest.slice(escaped[0].length);
  }
  return value;
}

function startsFormula(value: string): boolean {
  let candidate = value;
  for (let i = 0; i < 4; i++) {
    if (FORMULA_PREFIX.test(candidate.normalize("NFKC"))) return true;
    const normalized = candidate.normalize("NFKC").replace(LEADING_IGNORABLE, "");
    if (FORMULA_PREFIX.test(normalized)) return true;
    const decoded = decodePrefix(candidate);
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return FORMULA_PREFIX.test(candidate.normalize("NFKC"));
}

/** CSV quoting and spreadsheet formula neutralisation for every web CSV cell. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = startsFormula(text) ? "'" + text : text;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
