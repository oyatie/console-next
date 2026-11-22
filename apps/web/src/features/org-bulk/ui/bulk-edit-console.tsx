// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { buttonClass } from "../../../ui/button/button-class";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { FormPattern } from "../../../ui/patterns/form";
import { FormSection } from "../../../ui/patterns/form-section";

export function BulkEditConsole({
  q,
  hasWorkplaces,
  countTitle,
  content,
  actions,
  onSubmit,
  overlays,
}: {
  q: ReadState;
  hasWorkplaces: boolean;
  countTitle?: string;
  content: ReactNode;
  actions: ReactNode;
  onSubmit: () => void;
  overlays?: ReactNode;
}) {
  return (
    <FormPattern
      q={q}
      head={{
        title: t("orgBulk.edit.pageTitle"),
        crumbs: <Crumbs items={[<Link key="org" to="/org">{t("orgStructure.title")}</Link>]} current={t("orgBulk.edit.pageTitle")} />,
        actions: (
          <Link to="/org" search={{}} className={buttonClass("ghost", { icon: true })} aria-label={t("orgBulk.close")}>
            <X size={16} aria-hidden />
          </Link>
        ),
      }}
      sections={
        hasWorkplaces && countTitle ? (
          <FormSection>
            <h2>{countTitle}</h2>
            {content}
          </FormSection>
        ) : (
          content
        )
      }
      actions={hasWorkplaces ? actions : null}
      onSubmit={onSubmit}
      overlays={overlays}
    />
  );
}
