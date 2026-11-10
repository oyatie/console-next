// The sign-in ID `login@domain` (decisions #33), as the sign-in screen reads it: the server's rule (platform-auth
// sign_in_id.rs), the domains this browser signed into (a local picker, never a lookup across tenants), and the
// autofill pause after a sign-out. Browser storage can be missing or throw; every read degrades to "nothing kept".

import { validCompanyDomain } from "../lib/pure/company-domain";

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
