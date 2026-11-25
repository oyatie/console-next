// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { PopoverButton } from "../../../ui/popover/popover-button";

/** The same population definition follows counts in the chart, list and change composer. `children`: a count shown in place of the bare word. */
export function HeadcountBasis({ children }: { children?: string }) {
  // One string is both the text shown and the name: speech input presses a control by the words on it.
  const text = children ? `${children} · ${t("uiBlocker.reason")}` : t("structure.headcount.explain");
  return <PopoverButton label={text} title={t("structure.headcount.label")} trigger={text}>
    {() => <p>{t("structure.headcount.basis")}</p>}
  </PopoverButton>;
}
