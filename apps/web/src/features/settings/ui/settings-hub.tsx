// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { myAccessQuery } from "../../../reference/authz/api";
import { settingsQuery } from "../../../reference/settings/api";
import { settingsViews, type SettingsView } from "../../../shell/settings-views";
import { QueryState } from "../../../lib/react/query-state";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import { approvalSummary, summaryFormatters, type SummaryCopy } from "../domain/summaries";
import s from "./settings-hub.module.css";

export function SettingsHub() {
  const access = useQuery(myAccessQuery);
  const router = useRouter();
  const rows = settingsViews(Object.values(router.routesByPath), access.data);
  return <SettingsHubView rows={rows} />;
}

const settingsCopy: SummaryCopy = (id, values) => isMessageId(id) ? t(id, values) : t("settingsHub.unknown");

function SettingsCard({ row }: { row: SettingsView }) {
  const format = summaryFormatters[row.summary.format] as (data: unknown, copy: SummaryCopy, date: (value: string) => string) => string;
  const q = useQuery<unknown, Error, string>({ ...row.summary, select: data => format(data, settingsCopy, fmtDate), retry: false });
  return <Card title={<Link to={row.to} className={s.link}>{t(row.label)}</Link>}>
    <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
      {value => <div className={s.value}>{value}</div>}
    </QueryState>
  </Card>;
}

function ApprovalSettingsCard() {
  const q = useQuery({ ...settingsQuery, select: data => approvalSummary(data, settingsCopy, fmtDate), retry: false });
  return <Card title={t("settingsHub.approval")}>
    <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
      {summary => <>
        <div className={s.value}>{summary.value}</div>
        {summary.hints.length > 0 && <ul className={`muted ${s.hints}`}>{summary.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
      </>}
    </QueryState>
  </Card>;
}

export function SettingsHubView({ rows }: { rows: readonly SettingsView[] }) {
  return <Page floorplan="P-05" head={{ title: t("shell.link.settings") }}>
    <section className={s.grid} aria-label={t("shell.settings.basics")}>
      {rows.map(row => <SettingsCard key={row.to} row={row} />)}
      <ApprovalSettingsCard />
    </section>
  </Page>;
}
