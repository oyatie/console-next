// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, LOCALES, t, type Locale } from "@console/i18n";
import { focusSoon } from "../../lib/react/announce";
import { setLocale } from "../locale";

/**
 * The UI language; the choice is kept on this device (shell/locale). The switch re-renders every
 * screen, which replaces this select: focus is put back on it (`id` names it), never dropped to the body.
 * `label` names it itself when no visible <label> does.
 */
export function LocaleSelect({ id, label }: { id: string; label?: boolean }) {
  return (
    <select
      id={id}
      className="field__input"
      aria-label={label ? t("shell.locale") : undefined}
      value={i18n.locale}
      onChange={(e) => void setLocale(e.target.value as Locale).then(() => focusSoon(id), () => undefined)}
    >
      {LOCALES.map((l) => <option key={l} value={l}>{t(`shell.locale.${l}`)}</option>)}
    </select>
  );
}
