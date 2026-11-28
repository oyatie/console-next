// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useServedCapability } from "../../authz/ui/use-documents-served";

export function BenefitCatalogLink() {
  const allowed = useServedCapability("served_benefit_catalog");
  return allowed ? <Link to="/benefits">{t("benefits.title")}</Link> : null;
}
