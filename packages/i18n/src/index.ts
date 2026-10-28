import { IntlMessageFormat } from "intl-messageformat";
import { bootEn, bootKo, type BootMessageId } from "./catalogs/boot";
import type { ScreenMessageId } from "./catalogs/ko";
import { applyJosa, resolveJosa } from "./josa";

export { josa } from "./josa";

export type MessageId = BootMessageId | ScreenMessageId;
export type Locale = "ko" | "en";
export const LOCALES: Locale[] = ["ko", "en"];
type Values = Record<string, string | number | Date | null | undefined>;
type Catalog = Partial<Record<MessageId, string>>;

let locale: Locale = "ko";
const listeners = new Set<() => void>();
const cache = new Map<string, IntlMessageFormat>();

export const i18n = {
  get locale() {
    return locale;
  },
  set(next: Locale) {
    if (next === locale) return;
    locale = next;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

// Sign-in and shell copy ships in the entry; each locale's screen catalog is its own chunk, loaded
// once before the first screen renders, so the initial load carries no screen copy at all.
const boot: Record<Locale, Catalog> = { ko: bootKo, en: bootEn };
const screens: Partial<Record<Locale, Catalog>> = {};
const loaders: Record<Locale, () => Promise<Catalog>> = {
  ko: () => import("./catalogs/ko").then((m) => m.ko),
  en: () => import("./catalogs/en").then((m) => m.en),
};
const loading = new Map<Locale, Promise<void>>();
/** Loads a locale's screen catalog (once); the router awaits it before any screen renders. */
export function loadCatalog(l: Locale = locale): Promise<void> {
  let p = loading.get(l);
  if (!p) {
    p = loaders[l]().then((c) => void (screens[l] = c));
    // A failed fetch (e.g. offline) may be retried by the next screen.
    p.catch(() => loading.delete(l));
    loading.set(l, p);
  }
  return p;
}

function format(source: string, values?: Values): string {
  const text = values ? applyJosa(source, values) : source;
  if (!values && !text.includes("{")) return text;
  const key = `${locale}\u0000${text}`;
  let fmt = cache.get(key);
  if (!fmt) cache.set(key, (fmt = new IntlMessageFormat(text, locale)));
  return resolveJosa(String(fmt.format(values as Record<string, string | number | Date>)));
}

/**
 * A translator over `catalogs` (Korean source plus other locales): the message for `id` in the
 * current locale, falling back to Korean, ICU-formatted with `values`.
 */
export function createT<K extends string>(cats: { ko: Record<K, string> } & Partial<Record<Locale, Partial<Record<K, string>>>>) {
  return (id: K, values?: Values): string => format(cats[locale]?.[id] ?? cats.ko[id], values);
}

const lookup = (id: MessageId) => screens[locale]?.[id] ?? boot[locale][id] ?? screens.ko?.[id] ?? boot.ko[id];

/**
 * The app catalog's translator: the current locale's message, falling back to Korean. An id whose
 * screen catalog has not loaded renders as the id itself (visible drift, never a crash).
 */
export const t = (id: MessageId, values?: Values): string => format(lookup(id) ?? id, values);

/** True when `id` is a catalog message (for ids built from runtime values, e.g. enums). */
export const isMessageId = (id: string): id is MessageId => lookup(id as MessageId) !== undefined;
