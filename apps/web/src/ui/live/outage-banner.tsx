// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";
import { i18n, t } from "@console/i18n";
import { Banner } from "../banner/banner";
import { Button } from "../button/button-base";
import { StatusPageLink } from "./status-page-link";

type OutageBannerSeverity = "major" | "partial" | "degraded";

export function OutageBanner({
  severity,
  title,
  affected,
  statusPageHref,
  retrying,
  onRetry,
}: {
  severity: OutageBannerSeverity;
  title: string | null;
  affected: readonly string[];
  statusPageHref: string;
  retrying?: boolean;
  onRetry: () => void;
}) {
  useSyncExternalStore(i18n.subscribe, () => i18n.locale, () => i18n.locale);
  const heading = title ?? t(`live.outage.${severity}.title`);
  const detail =
    affected.length > 0
      ? t("live.outage.body", { affected: affected.join(", ") })
      : t("live.outage.generic");

  return (
    <Banner
      placement="page"
      tone={severity === "major" ? "danger" : "warn"}
      live="assertive"
      title={heading}
      actions={
        <>
          <StatusPageLink href={statusPageHref} size="sm" />
          <Button size="sm" pending={retrying} onClick={onRetry}>
            {t("live.retry")}
          </Button>
        </>
      }
    >
      {detail}
    </Banner>
  );
}
