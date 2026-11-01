// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { PopoverButton } from "../../../ui/popover/popover-button";

/** The same population definition follows counts in the chart, list and change composer. */
export function HeadcountBasis({ children }: { children?: ReactNode }) {
  return <PopoverButton label={t("structure.headcount.explain")} title={t("structure.headcount.label")}
    trigger={<>{children ?? t("structure.headcount.label")} · {t("uiBlocker.reason")}</>}>
    {() => <p>{t("structure.headcount.basis")}</p>}
  </PopoverButton>;
}
