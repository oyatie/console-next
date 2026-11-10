// SPDX-License-Identifier: LicenseRef-Proprietary
/** The login part: a-z 0-9, plus . _ - inside, no two separators in a row, 1 to 32 characters. */
const LOGIN = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
/** The domain part: today the tenant slug. */
import { validCompanyDomain } from "../lib/pure/company-domain";

type Parsed =
  | { kind: "ok"; id: string; domain: string }
  /** A bare login with several remembered domains: the person picks one. */
  | { kind: "pick"; login: string; domains: string[] }
  /** A bare login and no remembered domain: ask for `@domain`. */
  | { kind: "needDomain" }
  /** Breaks the rule; `nonAscii` when a Korean or full-width character is the cause (the Korean/English key). */
  | { kind: "invalid"; nonAscii: boolean };

const validLogin = (login: string) => LOGIN.test(login) && !/[._-]{2}/.test(login);

/** Reads what the person typed: trimmed, NFC, lowercase, then the rule. A bare login is completed from `domains`. */
export function parseSignInId(raw: string, domains: string[]): Parsed {
  const text = raw.trim().normalize("NFC").toLowerCase();
  // any non-ASCII is "Korean/English key"; a stray emoji gets the same hint, which is still the right fix.
  if (/[^\x20-\x7e]/.test(text)) return { kind: "invalid", nonAscii: true };
  const at = text.indexOf("@");
  const login = at < 0 ? text : text.slice(0, at);
  if (!validLogin(login)) return { kind: "invalid", nonAscii: false };
  if (at >= 0) {
    const domain = text.slice(at + 1);
    return validCompanyDomain(domain) ? { kind: "ok", id: `${login}@${domain}`, domain } : { kind: "invalid", nonAscii: false };
  }
  if (domains.length === 1) return { kind: "ok", id: `${login}@${domains[0]}`, domain: domains[0]! };
  return domains.length ? { kind: "pick", login, domains } : { kind: "needDomain" };
}

