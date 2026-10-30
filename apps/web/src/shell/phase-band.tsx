// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState, type ReactNode } from "react";
import { session } from "@console/api";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { codeText } from "../lib/labels";
import { isAnswer } from "../lib/react/query-defaults";
import { myAccessQuery } from "../reference/authz/api";
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
  const { q } = useSetupChecklist();
  const access = useQuery(myAccessQuery);
  const [now, setNow] = useState(Date.now);
  const data = q.isError && isAnswer(q.error) ? undefined : q.data;
  const band = data && access.data ? phaseBand(access.data.phase, data.go_live_at, Math.max(now, q.dataUpdatedAt)) : null;
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
  const phase = access.data?.phase === "SETUP" ? "setup" : "operating";
  const next = access.data?.phase === "SETUP" ? currentStep(data?.steps ?? []) : undefined;
  const label = access.data?.phase === "SETUP" ? t("shell.phase.setup") : t("setup.phase.operating");
  const text = next ? `${label} · ${codeText(`setup.step.${next}`, "")}` : label;
  const loading = access.isPending && !access.data;
  const failed = q.isError && !isAnswer(q.error);
  const phaseFailed = access.isError && !isAnswer(access.error);
  const fault = phaseFailed ? access : failed ? q : null;
  const failureText = `${t(phaseFailed ? "setup.phase.failed" : "setup.phase.checklistFailed")} ${t("common.read.failedReason")}`;
  const slot = <div className={s.band} data-phase-band={loading ? "loading" : fault ? "failed" : "ready"}>
    {loading ? <Skeleton bones={["short"]} label={t("common.loading")} /> : <>
        {access.data && <PhaseLine phase={phase}><span className={s.text} title={text}>{text}</span></PhaseLine>}
        {fault && <>
          <span className={s.text} title={failureText}>{failureText}</span>
          <Button variant="ghost" size="sm" onClick={() => { void fault.refetch(); }}>{t("common.retry")}</Button>
        </>}
        {band === "started" && dismissed !== receipt && <>
          <span className={s.text} title={t("setup.phase.started.detail")}>{t("setup.phase.started.title")}</span>
          <Button variant="ghost" size="sm" onClick={dismiss}>{t("setup.phase.dismiss")}</Button>
        </>}
      </>}
  </div>;
  return <PagePhase value={slot}>{children}</PagePhase>;
}
