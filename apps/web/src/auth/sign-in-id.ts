// The sign-in ID `login@domain` (decisions #33), as the sign-in screen reads it: the server's rule (platform-auth
// sign_in_id.rs), the domains this browser signed into (a local picker, never a lookup across tenants), and the
// autofill pause after a sign-out. Browser storage can be missing or throw; every read degrades to "nothing kept".

/** The login part: a-z 0-9, plus . _ - inside, no two separators in a row, 1 to 32 characters. */
const LOGIN = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
/** The domain part: today the tenant slug. */
import { validCompanyDomain } from "../lib/pure/company-domain";

export type Parsed =
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

const DOMAINS_KEY = "console.signIn.domains";
const PAUSE_KEY = "console.signIn.autofillPaused";
const read = (store: () => Storage, key: string) => {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
};
const write = (store: () => Storage, key: string, value: string | null) => {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // Private mode or blocked storage: nothing is remembered, and nothing breaks.
  }
};

/** Domains this browser signed into, most recent first (never a login). */
export function rememberedDomains(): string[] {
  try {
    const list: unknown = JSON.parse(read(() => localStorage, DOMAINS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string" && validCompanyDomain(d)) : [];
  } catch {
    return [];
  }
}
export const rememberDomain = (domain: string, previous?: string) =>
  write(() => localStorage, DOMAINS_KEY, JSON.stringify([domain, ...rememberedDomains().filter((d) => d !== domain && d !== previous)].slice(0, 5)));
/** Signing out on this device forgets them. */
export const forgetDomains = () => write(() => localStorage, DOMAINS_KEY, null);

/**
 * After a sign-out or a failed sign-in in this tab, the browser's autofill is not started on load (a person who just
 * signed out is not signed back in by the first suggestion); it starts when the field is focused instead.
 */
export const autofillPaused = () => read(() => sessionStorage, PAUSE_KEY) === "1";
export const pauseAutofill = () => write(() => sessionStorage, PAUSE_KEY, "1");
export const resumeAutofill = () => write(() => sessionStorage, PAUSE_KEY, null);
