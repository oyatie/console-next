// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState, type ReactNode } from "react";
import { session } from "@console/api";
import { t } from "@console/i18n";
import { codeText } from "../lib/labels";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";
import { phaseBand } from "../features/onboarding/domain/phase";
import { Button } from "../ui/button/button";
import { PagePhase } from "../ui/page/page-scope";
import { PhaseLine } from "../ui/page-head/phase-line";
import { Skeleton } from "../ui/skeleton/skeleton";
import { currentStep } from "../ui/setup-rail/setup-rail";
import s from "./phase-band.module.css";

/** The page head owns one phase slot, from the first paint through loading and failure. */
export function PhaseBand({ children }: { children: ReactNode }) {
  const principal = session.principal;
  const dismissKey = principal ? `console.phase.dismissed.${principal}` : null;
  const [dismissed, setDismissed] = useState(() => {
    try { return dismissKey ? localStorage.getItem(dismissKey) : null; } catch { return null; }
  });
  const { phaseQ: q } = useSetupChecklist();
  const [now, setNow] = useState(Date.now);
  const data = q.data;
  const band = data ? phaseBand(data.phase, data.go_live_at, Math.max(now, q.dataUpdatedAt)) : null;
  const receipt = data ? `${data.phase}:${data.go_live_at ?? ""}` : null;
  useEffect(() => {
    if (band !== "started" || !data?.go_live_at) return;
    const remaining = Date.parse(data.go_live_at) + 7 * 86400000 - Date.now();
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [band, data?.go_live_at]);
  const dismiss = () => {
    setDismissed(receipt);
    try { if (dismissKey && receipt) localStorage.setItem(dismissKey, receipt); } catch { return; /* Storage is optional. */ }
  };
  const phase = data?.phase === "SETUP" ? "setup" : "operating";
  const next = data?.phase === "SETUP" ? currentStep(data.steps ?? []) : undefined;
  const label = data?.phase === "SETUP" ? t("shell.phase.setup") : t("setup.phase.operating");
  const text = next ? `${label} · ${codeText(`setup.step.${next}`, "")}` : label;
  const loading = q.isPending;
  const failed = q.isError || !data;
  const slot = <div className={s.band} data-phase-band={loading ? "loading" : failed ? "failed" : "ready"}>
    {loading ? <Skeleton bones={["short"]} label={t("common.loading")} /> : failed ? <span className={s.text}>{t("common.read.failedReason")}</span>
      : <>
        <PhaseLine phase={phase}><span className={s.text} title={text}>{text}</span></PhaseLine>
        {band === "started" && dismissed !== receipt && <>
          <span className={s.text} title={t("setup.phase.started.detail")}>{t("setup.phase.started.title")}</span>
          <Button variant="ghost" size="sm" onClick={dismiss}>{t("setup.phase.dismiss")}</Button>
        </>}
      </>}
  </div>;
  return <PagePhase value={slot}>{children}</PagePhase>;
}
