// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState, type ReactNode } from "react";
import { session } from "@console/api";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { codeText } from "../lib/labels";
import { isAnswer } from "../lib/react/query-defaults";
import { myAccessQuery } from "../reference/authz/api";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";
import { phaseBand, receiptDuration } from "../features/onboarding/domain/phase";
import { settingsQuery } from "../reference/settings/api";
import { Button } from "../ui/button/button";
import { PagePhase } from "../ui/page/page-scope";
import { PhaseLine } from "../ui/page-head/phase-line";
import { Skeleton } from "../ui/skeleton/skeleton";
import { currentStep } from "../ui/setup-rail/setup-rail";
import s from "./phase-band.module.css";

/** One page-head notice while setup needs attention or the go-live receipt is current. */
export function PhaseBand({ children }: { children: ReactNode }) {
  const principal = session.principal;
  const dismissKey = principal ? `console.phase.dismissed.${principal}` : null;
  const [dismissed, setDismissed] = useState(() => {
    try { return dismissKey ? localStorage.getItem(dismissKey) : null; } catch { return null; }
  });
  const { phaseQ: q } = useSetupChecklist();
  const access = useQuery(myAccessQuery);
  const settings = useQuery(settingsQuery);
  const duration = receiptDuration(settings.data?.items);
  const [now, setNow] = useState(Date.now);
  const data = q.isError && isAnswer(q.error) ? undefined : q.data;
  const band = access.data ? phaseBand(access.data.phase, data?.go_live_at, Math.max(now, q.dataUpdatedAt), duration) : null;
  const receipt = data ? `${data.phase}:${data.go_live_at ?? ""}` : null;
  useEffect(() => {
    if (band !== "started" || !data?.go_live_at) return;
    const remaining = Date.parse(data.go_live_at) + duration - Math.max(now, Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(0, remaining)));
    return () => window.clearTimeout(timer);
  }, [band, data?.go_live_at, duration, now]);
  const dismiss = () => {
    setDismissed(receipt);
    try { if (dismissKey && receipt) localStorage.setItem(dismissKey, receipt); } catch { return; /* Storage is optional. */ }
  };
  const next = band === "setup" ? currentStep(data?.steps ?? []) : undefined;
  const label = t("shell.phase.setup");
  const text = next ? `${label} · ${codeText(`setup.step.${next}`, "")}` : label;
  const slot = <PhaseSlot phase={band === "started" && dismissed === receipt ? undefined : band ?? undefined} text={text} dismiss={dismiss} />;
  return <PagePhase value={slot}>{children}</PagePhase>;
}

/** Shared rendering for the live page head and its gallery states. */
export function PhaseSlot({ loading = false, phase, text, dismiss }: {
  loading?: boolean;
  phase?: "setup" | "started";
  text?: string;
  dismiss?: () => void;
}) {
  if (!loading && !phase) return null;
  return <div className={s.band} data-phase-band={loading ? "loading" : phase}>
    {loading ? <Skeleton bones={["short"]} label={t("common.loading")} /> : <>
        {phase === "setup" && <PhaseLine phase="setup">{text}</PhaseLine>}
        {phase === "started" && <>
          <strong>{t("setup.receipt.started.title")}</strong>
          <span>{t("setup.receipt.started.detail")}</span>
          <Button variant="ghost" size="sm" onClick={dismiss}>{t("setup.phase.dismiss")}</Button>
        </>}
      </>}
  </div>;
}
