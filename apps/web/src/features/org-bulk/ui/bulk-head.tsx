// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import { PageHead } from "../../../ui/page-head/page-head";
import { Crumbs } from "../../../ui/page-head/crumbs";

/** The full-page head of a bulk path (spec D9): crumb, title, then the steps or the place it writes under, and close. */
export function BulkHead({ title, crumb, under, children }: { title: string; crumb?: string; under?: string; children?: ReactNode }) {
  return (
    <PageHead
      band
      title={title}
      crumbs={<Crumbs items={[<Link key="org" to="/org" search={{}}>{t("orgBulk.crumb")}</Link>]} current={crumb} />}
      meta={under}
      tabs={children}
      tools={<Link to="/org" search={{}} className="btn btn--ghost" aria-label={t("orgBulk.close")}><X size={18} aria-hidden /></Link>}
    />
  );
}
