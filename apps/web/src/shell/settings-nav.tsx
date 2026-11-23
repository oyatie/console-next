// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import type { SettingsView } from "./settings-views";
import s from "./settings-nav.module.css";

/** Shared Console `P9` `SettingsPattern` left-rail navigation between accessible company & people settings. */
export function SettingsViewsNav({
  items,
  current,
}: {
  items: readonly SettingsView[];
  current: SettingsView["to"];
}) {
  return (
    <nav className={s.nav} aria-label={t("shell.link.settings")}>
      {items.map(item => (
        <Link
          key={item.to}
          to={item.to}
          className={s.item}
          aria-current={item.to === current ? "page" : undefined}
        >
          <bdi>{t(item.label)}</bdi>
        </Link>
      ))}
    </nav>
  );
}
