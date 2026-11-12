import { useEffect, useState } from "react";
import { THEME_KEY, THEMES } from "../lib/prefs";

type Theme = (typeof THEMES)[number];
const system = (): Theme => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const stored = (): Theme | null => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.find((t) => t === v) ?? null;
  } catch {
    return null;
  }
};

/** Explicit choice wins; otherwise follow the OS. Applied as `data-theme` on <html>. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());
  useEffect(() => {
    // public/prefs.js put this same theme on <html> before the first paint: write only a change, never the same value again.
    const root = document.documentElement;
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
  }, [theme]);
  const toggle = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {}
      return next;
    });
  return [theme, toggle];
}
