// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { buttonClass } from "../../../ui/button/button-class";
import { WizardPattern } from "../../../ui/patterns/wizard";

export function GoLiveConsole({
  q,
  operating,
  notes,
  body,
  aside,
  asideLabel,
  notice,
  consequence,
  actions,
}: {
  q: ReadState;
  operating: boolean;
  notes?: ReactNode;
  body: ReactNode;
  aside: ReactNode;
  asideLabel: string;
  notice?: ReactNode;
  consequence: ReactNode;
  actions: ReactNode;
}) {
  return (
    <WizardPattern
      q={q}
      head={{
        title: t("setup.golive.title"),
        actions: (
          <Link to="/" className={buttonClass("ghost", { size: "sm" })}>
            {t(operating ? "shell.link.home" : "setup.title")}
          </Link>
        ),
      }}
      notes={notes}
      body={body}
      asideLabel={asideLabel}
      aside={aside}
      notice={notice}
      consequence={consequence}
      actions={actions}
    />
  );
}
