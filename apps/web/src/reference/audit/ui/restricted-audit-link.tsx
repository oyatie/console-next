// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { streamAccessQuery } from "../api";

export function RestrictedAuditLink({ className }: { className?: string }) {
  const access = useQuery(streamAccessQuery);
  return access.isSuccess && (access.data?.events || access.data?.access_events)
    ? <Link to="/audit/restricted" className={className}>{t("audit.restricted.title")}</Link> : null;
}
