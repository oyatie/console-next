// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { session } from "@console/api";
import { cancelledRecoveryNotice, dismissCancelledRecoveryNotice, subscribeCancelledRecovery } from "@console/api/recovery-notice";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { codeText } from "../lib/labels";
import { isAnswer } from "../lib/react/query-defaults";
import { myAccessQuery } from "../reference/authz/api";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";
import { canReadSetupChecklist, phaseBand, receiptDuration } from "../features/onboarding/domain/phase";
import { settingsQuery } from "../reference/settings/api";
import { Banner } from "../ui/banner/banner";
import { Button } from "../ui/button/button";
import { PagePhase } from "../ui/page/page-scope";
import { PhaseLine } from "../ui/page-head/phase-line";
import { Skeleton } from "../ui/skeleton/skeleton";
import { currentStep } from "../ui/setup-rail/current-step";
import s from "./phase-band.module.css";

const PHASE_HOLD_MS = 2000;
// A remounted route keeps its principal's deadline. A null deadline means the page has settled.
const deadlines = new Map<typeof session.principal, number | null>();

/** One page-head notice while setup needs attention or the go-live receipt is current. */
export function PhaseBand({ children, operatingSince }: { children: ReactNode; operatingSince?: string | null }) {
  const principal = session.principal;
  const dismissKey = principal ? `console.phase.dismissed.${principal}` : null;
  const [dismissed, setDismissed] = useState(() => {
    try { return dismissKey ? localStorage.getItem(dismissKey) : null; } catch { return null; }
  });
  const { phaseQ: q, readable } = useSetupChecklist();
  const access = useQuery(myAccessQuery);
  const settings = useQuery(settingsQuery);
  // The shell identity and the checklist read the same go-live timestamp. Only setup needs the step list here.
  const needsTimestamp = q.data === undefined && !isAnswer(q.error) && (q.isPending || q.isError);
  const useIdentity = needsTimestamp && readable && access.isSuccess && access.data.phase === "OPERATING"
    && canReadSetupChecklist(access.data) && operatingSince !== undefined && settings.isSuccess && settings.data.items !== undefined;
  const [settled, setSettled] = useState(() => deadlines.get(principal) === null);
  const decided = settled || (access.data !== undefined || access.failureCount > 0)
    && (access.data?.phase === "SETUP" || useIdentity || !q.isPending || q.failureCount > 0);
  if (decided && !settled) setSettled(true);
  useEffect(() => {
    if (decided) {
      if (principal) deadlines.set(principal, null);
      return;
    }
    const until = deadlines.get(principal) ?? Date.now() + PHASE_HOLD_MS;
    if (principal) deadlines.set(principal, until);
    const timer = window.setTimeout(() => setSettled(true), until - Date.now());
    return () => window.clearTimeout(timer);
  }, [principal, decided]);
  const duration = receiptDuration(settings.data?.items);
  const [now, setNow] = useState(Date.now);
  const data = q.isError && isAnswer(q.error) ? undefined : q.data;
  const goLiveAt = useIdentity ? operatingSince : data?.go_live_at;
  const band = access.data ? phaseBand(access.data.phase, goLiveAt, Math.max(now, q.dataUpdatedAt), duration) : null;
  const receiptPhase = useIdentity ? "OPERATING" : data?.phase;
  const receipt = receiptPhase ? `${receiptPhase}:${goLiveAt ?? ""}` : null;
  useEffect(() => {
    if (band !== "started" || !goLiveAt) return;
    const remaining = Date.parse(goLiveAt) + duration - Math.max(now, Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(0, remaining)));
    return () => window.clearTimeout(timer);
  }, [band, goLiveAt, duration, now]);
  const dismiss = () => {
    setDismissed(receipt);
    try { if (dismissKey && receipt) localStorage.setItem(dismissKey, receipt); } catch { return; /* Storage is optional. */ }
  };
  const next = band === "setup" ? currentStep(data?.steps ?? []) : undefined;
  const label = t("shell.phase.setup");
  const text = next ? `${label} · ${codeText(`setup.step.${next}`, "")}` : label;
  const autoCancelled = useSyncExternalStore(subscribeCancelledRecovery, cancelledRecoveryNotice, () => false);
  // Access can observe go-live before the matching checklist refresh supplies its receipt.
  const transitioning = access.data?.phase === "OPERATING" && data?.phase === "SETUP" && q.isFetching;
  const slot = transitioning ? <div className={s.band} aria-hidden="true" /> : <PhaseSlot phase={band === "started" && dismissed === receipt ? null : band} text={text} dismiss={dismiss} />;
  return <PagePhase value={{ slot, settled: decided }}>
    {!decided && <div className="page"><Skeleton bones={["crumb", "title", "line", "row", "row", "row"]} label={t("common.loading")} /></div>}
    <div className={s.content} data-phase-pending={!decided || undefined} inert={!decided} aria-hidden={!decided || undefined}>
      {autoCancelled && (
        <Banner live="polite">
          {t("auth.recovery.autoCancelled")}
          <Button variant="ghost" size="sm" onClick={dismissCancelledRecoveryNotice}>{t("common.closePanel")}</Button>
        </Banner>
      )}
      {children}
    </div>
  </PagePhase>;
}

/** Shared rendering for the live page head and its gallery states. */
export function PhaseSlot({ phase, text, dismiss }: {
  phase?: "setup" | "started" | null;
  text?: string;
  dismiss?: () => void;
}) {
  if (!phase) return null;
  return <div className={s.band} data-phase-band={phase}>
    {phase === "setup" ? <PhaseLine phase="setup">{text}</PhaseLine> : <>
      <strong>{t("setup.receipt.started.title")}</strong>
      <span>{t("setup.receipt.started.detail")}</span>
      <Button variant="ghost" size="sm" onClick={dismiss}>{t("setup.phase.dismiss")}</Button>
    </>}
  </div>;
}
