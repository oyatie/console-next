import { useEffect, useState, type ReactNode } from "react";
import { session } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { t } from "@console/i18n";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";
import { phaseBand } from "../features/onboarding/domain/phase";
import { Banner } from "../ui/banner/banner";
import { isAnswer } from "../lib/react/query-defaults";
import { QueryState } from "../lib/react/query-state";
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
  const { phaseQ: q } = useSetupChecklist(saved);
  const [now, setNow] = useState(Date.now);
  const [inFlow] = useState(() => Boolean(saved && phaseBand(saved.phase, saved.go_live_at, now)));
  const band = q.data ? phaseBand(q.data.phase, q.data.go_live_at, Math.max(now, q.dataUpdatedAt)) : null;
  useEffect(() => {
    if (!key || !q.data || q.isPlaceholderData || q.isError) return;
    try { localStorage.setItem(key, JSON.stringify(q.data)); } catch { return; /* Storage is optional; the server read remains authoritative. */ }
  }, [key, q.data, q.isPlaceholderData, q.isError]);
  useEffect(() => {
    if (band !== "started" || !q.data?.go_live_at) return;
    const remaining = Date.parse(q.data.go_live_at) + 7 * 86400000 - Date.now();
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [band, q.data?.go_live_at]);
  const notice = band ? <Banner placement="page" title={t(`setup.phase.${band}.title`)}>{t(`setup.phase.${band}.detail`)}</Banner> :
    !q.isPending && q.isError && !q.data && !isAnswer(q.error) ? <QueryState q={q}>{() => null}</QueryState> : null;
  return <>
    {inFlow && notice}
    {children}
    {!inFlow && notice && <div className={s.floating}>{notice}</div>}
  </>;
}
