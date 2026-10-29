// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState, type ReactNode } from "react";
import { session } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { t } from "@console/i18n";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";
import { phaseBand } from "../features/onboarding/domain/phase";
import { Banner } from "../ui/banner/banner";
import { Button } from "../ui/button/button";
import s from "./phase-band.module.css";

const remembered = (key: string | null): Checklist | undefined => {
  try {
    const data: Checklist | null = JSON.parse(key ? localStorage.getItem(key) ?? "null" : "null");
    return data && (data.phase === "SETUP" || data.phase === "OPERATING") &&
      (data.go_live_at === null || typeof data.go_live_at === "string" && Number.isFinite(Date.parse(data.go_live_at))) ? data : undefined;
  } catch { return undefined; }
};

/** The last successful phase stays visible through a failed read or expired session. */
export function PhaseBand({ children }: { children: ReactNode }) {
  const principal = session.principal;
  const key = principal ? `console.phase.${principal}` : null;
  const [saved] = useState(() => remembered(key));
  const dismissKey = principal ? `console.phase.dismissed.${principal}` : null;
  const [dismissed, setDismissed] = useState(() => {
    try { return dismissKey ? localStorage.getItem(dismissKey) : null; } catch { return null; }
  });
  const { phaseQ: q } = useSetupChecklist(saved);
  const [now, setNow] = useState(Date.now);
  const data = q.data ?? saved;
  const band = data ? phaseBand(data.phase, data.go_live_at, Math.max(now, q.dataUpdatedAt)) : null;
  const receipt = data ? `${data.phase}:${data.go_live_at ?? ""}` : null;
  useEffect(() => {
    if (!key || !q.data || q.isPlaceholderData || q.isError) return;
    try { localStorage.setItem(key, JSON.stringify(q.data)); } catch { return; /* Storage is optional; the server read remains authoritative. */ }
  }, [key, q.data, q.isPlaceholderData, q.isError]);
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
  return <>
    {band && dismissed !== receipt && <div className={s.band}><Banner placement="page" title={t(`setup.phase.${band}.title`)}
      actions={<Button variant="ghost" onClick={dismiss}>{t("setup.phase.dismiss")}</Button>}>{t(`setup.phase.${band}.detail`)}</Banner></div>}
    {children}
  </>;
}
