// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, type ReactNode } from "react";
import { t } from "@console/i18n";
import { StatusBar } from "../../ui/status-bar/status-bar";
import { usePublishedStatusBar, usePublishedStatusTrailing } from "../../ui/status-bar/status-bar-store";

export function ConsoleStatusBar({ platform, tenantName, currentTitle, inboxCount, inboxExact }: {
  platform?: boolean; tenantName?: string; currentTitle: string; inboxCount?: number; inboxExact: boolean;
}) {
  const publishedSegments = usePublishedStatusBar();
  const trailing = usePublishedStatusTrailing();
  const statusSegments = useMemo(() => {
    if (publishedSegments && publishedSegments.length > 0) {
      return publishedSegments;
    }
    const segments: { id: string; content: ReactNode; tone?: "default" | "strong" | "attention" }[] = [
      { id: "scope", content: platform ? t("shell.hub.platform") : tenantName ?? t("app.name"), tone: "strong" },
      { id: "module", content: currentTitle },
    ];
    if (!platform && inboxCount !== undefined && inboxCount > 0) {
      segments.push({
        id: "inbox",
        content: t(inboxExact ? "shell.needsMe.count" : "shell.needsMe.countMore", { count: inboxCount }),
        tone: "attention",
      });
    }
    return segments;
  }, [publishedSegments, platform, tenantName, currentTitle, inboxCount, inboxExact]);

  return <StatusBar segments={statusSegments} trailing={trailing} />;
}
