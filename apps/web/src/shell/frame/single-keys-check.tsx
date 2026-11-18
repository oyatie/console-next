// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useId, useState } from "react";
import { t } from "@console/i18n";
import { SINGLE_KEYS_KEY, singleKeysOn } from "../../lib/prefs";
import { Check } from "../../ui/button/button";

/**
 * Single-key shortcuts on this device (WCAG 2.1.4, Character Key Shortcuts): checked is on. Off is the one stored
 * value and on removes it. The key handlers read the choice at each key, so it applies without a reload; the box is
 * a switch for that reason, and follows a change made in another tab, as the keys here already do.
 */
export function SingleKeysCheck() {
  const hint = useId();
  const [on, setOn] = useState(singleKeysOn);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const read = () => setOn(singleKeysOn());
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);
  return <>
    <Check switch checked={on} aria-describedby={hint} onChange={next => {
      try {
        if (next) localStorage.removeItem(SINGLE_KEYS_KEY);
        else localStorage.setItem(SINGLE_KEYS_KEY, "off");
      } catch { setFailed(true); return; }
      setFailed(false);
      setOn(next);
    }}>{t("account.singleKeys")}</Check>
    <p id={hint} className="muted">{t("account.singleKeys.device")}</p>
    {failed && <span role="alert">{t("account.singleKeys.failed")}</span>}
  </>;
}
