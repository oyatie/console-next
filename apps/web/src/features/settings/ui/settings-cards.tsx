// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { chunk } from "../../../lib/chunk-guard";
import { get } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { settingsQuery } from "../../../reference/settings/api";
import { type SettingsView } from "../../../shell/settings-views";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { approvalSummary, domainSummary, experienceSummary, summaryFormatters, type SummaryCopy } from "../domain/summaries";
import s from "./settings-hub.module.css";

const ScreenStyleSheet = lazy(() => chunk(import("./screen-style-sheet")).then(m => ({ default: m.ScreenStyleSheet })));

const settingsCopy: SummaryCopy = (id, values) => (isMessageId(id) ? t(id, values) : t("settingsHub.unknown"));

export function SettingsCard({ row }: { row: SettingsView }) {
  const domain = row.summary.format === "domain";
  const me = useQuery({ ...get("/api/v1/users/me"), enabled: domain, staleTime: Infinity, retry: false });
  const format = summaryFormatters[row.summary.format] as (data: unknown, copy: SummaryCopy, date: (value: string) => string) => string;
  const q = useQuery<unknown, Error, string>({
    ...row.summary,
    select: data =>
      domain
        ? domainSummary(data as Parameters<typeof domainSummary>[0], settingsCopy, me.data?.sign_in_id)
        : format(data, settingsCopy, fmtDate),
    retry: false,
  });
  return (
    <Card title={<Link to={row.to} className={s.link}>{t(row.label)}<ChevronRight size={16} aria-hidden /></Link>}>
      <QueryState q={domain ? { ...q, isPending: q.isPending || me.isPending, error: q.error || me.error } : q} inline own={() => t("settingsHub.unknown")}>
        {value => <div className={s.value}>{value}</div>}
      </QueryState>
    </Card>
  );
}

export function ApprovalSettingsCard({ onManage }: { onManage?: () => void }) {
  const q = useQuery({ ...settingsQuery, select: data => ({ ...approvalSummary(data, settingsCopy, fmtDate), canChange: data.can_change }) });
  return (
    <Card title={t("settingsHub.approval")}>
      <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
        {summary => (
          <>
            <div className={s.row}>
              <div className={s.value}>{summary.value}</div>
              {onManage && summary.canChange && (
                <Button size="sm" variant="secondary" onClick={onManage}>
                  {t("settingsHub.operations.editAction")}
                </Button>
              )}
            </div>
            {summary.hints.length > 0 && <ul className={`muted ${s.hints}`}>{summary.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
          </>
        )}
      </QueryState>
    </Card>
  );
}

export function ModuleOperationsCard({ onManage }: { onManage: () => void }) {
  const q = useQuery(settingsQuery);
  const byKey = new Map((q.data?.items ?? []).map(item => [item.key, item]));
  const payroll = byKey.get("module.payroll.enabled");
  const week52 = byKey.get("attendance.week52.warn_hours");
  if (!payroll && !week52) return null;
  const parts = [
    payroll ? t(payroll.value ? "settingsHub.operations.payrollOn" : "settingsHub.operations.payrollOff") : null,
    week52 && typeof week52.value === "number" ? t("settingsHub.operations.week52", { hours: week52.value }) : null,
  ].filter(Boolean);
  return (
    <Card title={t("settingsHub.operations.title")}>
      <div className={s.row}>
        <div className={s.value}>{parts.join(" · ")}</div>
        {q.data?.can_change && (
          <Button size="sm" variant="secondary" onClick={onManage}>
            {t("settingsHub.operations.editAction")}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function ScreenStyleSettingsCard() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...settingsQuery, select: data => experienceSummary(data, settingsCopy, fmtDate) });
  return (
    <Card title={t("settingsHub.key.display.experience")}>
      <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
        {summary => (
          <>
            <div className={s.row}>
              <div className={s.value}>{summary.value}</div>
              {summary.canEdit && summary.entry && <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>{t("settingsHub.experience.change")}</Button>}
            </div>
            {summary.hints.length > 0 && <ul className={`muted ${s.hints}`}>{summary.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
            {open && summary.entry && <Suspense fallback={null}><ScreenStyleSheet entry={summary.entry} onClose={() => setOpen(false)} /></Suspense>}
          </>
        )}
      </QueryState>
    </Card>
  );
}
