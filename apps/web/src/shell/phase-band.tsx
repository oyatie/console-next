import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { t } from "@console/i18n";
import { checklistQuery } from "../features/onboarding/api";
import { phaseBand } from "../features/onboarding/domain/phase";
import { Banner } from "../ui/banner/banner";
import { Skeleton } from "../ui/skeleton/skeleton";

/** The last successful phase stays visible through a failed read or expired session. */
export function PhaseBand({ children }: { children: ReactNode }) {
  const q = useQuery({ ...checklistQuery, retry: false });
  const [now, setNow] = useState(Date.now);
  const band = q.data ? phaseBand(q.data.phase, q.data.go_live_at, Math.max(now, q.dataUpdatedAt)) : null;
  useEffect(() => {
    if (band !== "started" || !q.data?.go_live_at) return;
    const remaining = Date.parse(q.data.go_live_at) + 7 * 86400000 - Date.now();
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [band, q.data?.go_live_at]);
  // Paint the phase and route together, so the late strip never moves a route's controls.
  if (q.isPending) return <Skeleton bones={["title", "row", "row"]} label={t("common.loading")} />;
  return <>
    {band && <Banner placement="page" title={t(`setup.phase.${band}.title`)}>{t(`setup.phase.${band}.detail`)}</Banner>}
    {children}
  </>;
}
