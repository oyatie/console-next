import type { ComponentType } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { useTheme } from "../shell/theme";
import { Button } from "../ui/button/button";
import { PageHead } from "../ui/page-head/page-head";
import "./gallery.css";

/**
 * Development/test-only (/_gallery): every shared UI component in
 * representative states, for visual regression (e2e/visual.spec.ts) and the axe gate. No backend.
 *
 * Entries are discovered, never listed here: any `src/**\/*.gallery.tsx` that default-exports a
 * component (usually a <Section>) is rendered, ascending by its `order` export, then by path.
 * Its copy goes in `@console/i18n/gallery`, which the bundle gate keeps out of production.
 */
type Entry = { default: ComponentType; order?: number };
const entries = Object.entries(import.meta.glob<Entry>("../**/*.gallery.tsx", { eager: true }))
  .sort(([a, x], [b, y]) => (x.order ?? Infinity) - (y.order ?? Infinity) || a.localeCompare(b));

export function Gallery() {
  const [theme, toggle] = useTheme();
  const entry = new URLSearchParams(location.search).get("entry");
  return (
    <main className="page" id="main">
      <PageHead title={tg("title")} sub={tg("hint")} tools={<Button onClick={toggle}>{theme === "dark" ? t("shell.theme.toLight") : t("shell.theme.toDark")}</Button>} />
      {entries.filter(([path]) => !entry || path.endsWith(`/${entry}.gallery.tsx`)).map(([path, { default: Demo }]) => <Demo key={path} />)}
    </main>
  );
}
