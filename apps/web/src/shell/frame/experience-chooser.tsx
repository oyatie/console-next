// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { experiences, resolveExperience } from "../../experience/table";
import { EXPERIENCE_KEY } from "../../lib/prefs";
import { SelectInput } from "../../ui/field/select-input";

export function ExperienceChooser() {
  const [failed, setFailed] = useState(false);
  const selected = resolveExperience(typeof document === "undefined" ? undefined : document.documentElement.dataset.experience);
  return <>
    <SelectInput id="account-experience" aria-label={t("account.experience")} aria-describedby="account-experience-hint"
      value={selected.id} onChange={event => {
        const next = resolveExperience(event.target.value);
        try { localStorage.setItem(EXPERIENCE_KEY, next.id); }
        catch { setFailed(true); return; }
        location.reload();
      }}>
      {experiences.map(experience => <option key={experience.id} value={experience.id}>{t(experience.label)}</option>)}
    </SelectInput>
    <p id="account-experience-hint" className="muted">{t("account.experience.device")}</p>
    {failed && <span role="alert">{t("account.experience.failed")}</span>}
  </>;
}
