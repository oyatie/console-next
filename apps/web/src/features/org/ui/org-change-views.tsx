// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { ToggleButton } from "../../../ui/button/button";
import { Count } from "../../../ui/count/count";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { CHANGE_VIEWS, type ChangeView } from "../api";

/** Saved views keep their names and focus while their count or list read is unavailable. */
export function OrgChangeViews({ view, routed, totals, failed, redrafts, redraftsFailed, unavailable, className, onPick }: {
  view: ChangeView;
  routed: boolean;
  totals?: Record<ChangeView, number>;
  failed: boolean;
  redrafts: number | undefined;
  redraftsFailed?: boolean;
  unavailable?: string;
  className: string;
  onPick: (view: ChangeView) => void;
}) {
  const views = (Object.keys(CHANGE_VIEWS) as ChangeView[]).filter(v => routed || v !== "approval");
  // Keep one reason line for the group so completing the initial read never moves the list below it.
  return <DisabledReason reason={unavailable ?? "\u00a0"} control={disabled => <span className={className}>
    {views.map(v => {
      const countFailed = failed || (v === "open" && redraftsFailed);
      const total = countFailed ? undefined : totals?.[v];
      const extra = v === "open" ? redrafts : 0;
      const n = total === undefined || extra === undefined ? undefined : total + extra;
      const label = <>{t(`orgChange.list.view.${v === "closed" && !routed ? "cancelled" : v}`, { count: "" })}<Count n={n} failed={countFailed ? t("orgChange.list.countFailed") : undefined} /></>;
      return <ToggleButton key={v} pressed={v === view} {...(unavailable ? disabled : { onClick: () => onPick(v) })}>{label}</ToggleButton>;
    })}
  </span>} />;
}
