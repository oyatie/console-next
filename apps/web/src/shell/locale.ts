import { setAcceptLanguage } from "@console/api";
import { i18n, loadCatalog, LOCALES, t, type Locale } from "@console/i18n";
import { chunk } from "../lib/chunk-guard";

// Locale: saved choice, else Korean (Korean-first product). Drives catalog text, Intl formats,
// <html lang>, the tab title and the Accept-Language the server localizes its messages with.
const KEY = "console.locale";
function apply(l: Locale) {
  // Fetch the screen catalog now, in parallel with the first screen's chunk (the router awaits it).
  void chunk(loadCatalog(l)).catch(() => undefined);
  i18n.set(l);
  document.documentElement.lang = l;
  document.title = t("app.name");
  setAcceptLanguage(l);
}

/** Call once at start-up, before the first render. */
export function initLocale() {
  try {
    const saved = localStorage.getItem(KEY) as Locale | null;
    apply(saved && LOCALES.includes(saved) ? saved : "ko");
  } catch {
    apply("ko");
  }
}

/** Switches once the new locale's screen catalog is in, so the re-render never shows a missing string. */
export async function setLocale(l: Locale) {
  await loadCatalog(l);
  apply(l);
  try {
    localStorage.setItem(KEY, l);
  } catch {}
}
