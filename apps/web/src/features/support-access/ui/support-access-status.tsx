// SPDX-License-Identifier: LicenseRef-Proprietary
import { Headset } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Chip } from "../../../ui/chip";
import { buttonClass } from "../../../ui/button/button-class";
import { activeSupportQuery, session, supportRefusal } from "../../../reference/support-access/api";
import styles from "./support-access.module.css";

/** Visible on every tenant page; the shell's SSE stream invalidates this read. */
export function ActiveSupportBanner() {
  const q = useQuery({ ...activeSupportQuery, enabled: !!session.token });
  if (!q.error && (!q.data || (!q.data.sessions.length && !(q.data.can_approve && q.data.pending_count)))) return null;
  return <section className={styles.status} aria-label={t("supportAccess.title")}>
    <QueryState q={q} own={supportRefusal}>{(data) => <>
    {data.can_approve && data.pending_count > 0 && <Banner placement="page" tone="warn" live="polite" title={t("supportAccess.pending", { count: fmtNumber(data.pending_count) })}
      actions={<Link to="/audit/support-access" search={{ review: data.pending_approvals[0]?.id }} className={buttonClass()}>{t("supportAccess.review")}</Link>}>
      {data.pending_approvals.map((s) => <p key={s.id}>{s.operator_label} · {t("supportAccess.requestDeadline", { at: fmtDateTime(s.request_expires_at) })}</p>)}
    </Banner>}
    {data.sessions.length > 0 && <Banner placement="page" tone="warn" live="polite" title={t("supportAccess.banner")}
      actions={data.can_approve ? <Link to="/audit/support-access" search={{ review: data.sessions[0]?.id }} className={buttonClass()}>{t("supportAccess.bannerAction")}</Link> : undefined}>
      {data.sessions.map((s) => <p key={s.id}>{s.operator_label} · {t("supportAccess.bannerExpiry", { at: s.expires_at ? fmtDateTime(s.expires_at) : "—" })}</p>)}
    </Banner>}
    </>}</QueryState>
  </section>;
}

/** The shell header keeps this visible while the page's detailed notice scrolls. */
export function SupportAccessIndicator() {
  const q = useQuery({ ...activeSupportQuery, enabled: !!session.token });
  if (q.error || !q.data) return null;
  const active = q.data.sessions.length;
  const pending = q.data.can_approve ? q.data.pending_count : 0;
  if (!active && !pending) return null;
  const label = t("supportAccess.indicatorLabel", { pending: fmtNumber(pending), active: fmtNumber(active) });
  const count = <Chip tone="warn"><span className={styles.indicatorText}>{t("supportAccess.indicator", { count: fmtNumber(active + pending) })}</span><span className={styles.indicatorCompact} aria-hidden><Headset size={16} /></span></Chip>;
  return q.data.can_approve
    ? <Link to="/audit/support-access" search={{ review: q.data.pending_approvals[0]?.id ?? q.data.sessions[0]?.id }} className={styles.indicator} aria-label={label} title={label}>{count}</Link>
    : <span className={styles.indicator} role="status" aria-label={label} title={label}>{count}</span>;
}

