// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState } from "react";
import { t } from "@console/i18n";
import { setSingleKeys } from "../../lib/prefs";
import { useSingleKeys } from "../../lib/react/use-single-keys";
import { Check } from "../../ui/button/button";
import css from "./single-keys-check.module.css";

/**
 * Single-key shortcuts on this device (WCAG 2.1.4, Character Key Shortcuts): checked is on. Off is the one stored
 * value and on removes it. The key handlers read the choice at each key, so it applies without a reload; the box is
 * a switch for that reason, and follows a change made in another tab, as the keys here already do.
 */
export function SingleKeysCheck() {
  const hint = useId();
  const on = useSingleKeys();
  const [failed, setFailed] = useState(false);
  return <div className={css.box}>
    <Check switch checked={on} aria-describedby={hint} onChange={next => {
      try { setSingleKeys(next); } catch { setFailed(true); return; }
      setFailed(false);
    }}>{t("account.singleKeys")}</Check>
    <p id={hint} className="muted">{t("account.singleKeys.device")}</p>
    {failed && <span role="alert">{t("account.singleKeys.failed")}</span>}
  </div>;
}
