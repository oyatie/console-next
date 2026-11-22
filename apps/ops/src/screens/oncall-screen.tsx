// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsOncall, OpsApiError, opsQueryKeys, type OpsCmdHandOff } from "../lib/api";
import { readOncallConfig } from "../lib/api-types";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { formatCount, formatDuration, formatUtcShort } from "../lib/format";
import { useOncallPageTestMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { CmdReceipt } from "../ui/cmd-receipt";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { KeyValue } from "../ui/key-value";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import { buildAlertsTabs } from "./hub-tabs";
import s from "./oncall-screen.module.css";

export function OncallScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.alerts");
  const canPageTest = hasOpsAction(me, "jobs.rerun");
  const pageTestMut = useOncallPageTestMutation();
  const [receipt, setReceipt] = useState<OpsCmdHandOff | null>(null);

  const query = useQuery({
    queryKey: opsQueryKeys.oncall,
    queryFn: fetchOpsOncall,
    enabled: allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data?.evaluated_at) reportEvaluatedAt(query.data.evaluated_at);
  }, [query.data?.evaluated_at, reportEvaluatedAt]);

  if (!allowed) {
    return (
      <O0State
        model={classifyOpsError(
          new OpsApiError(403, {
            code: "OPS_ACTION_DENIED",
            message: "On-call view requires read.alerts permission.",
            support_ref: "cedar-oncall",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.alerts.title} meta={COPY.loading.oncallTitle} tabs={buildAlertsTabs("oncall")} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const cfg = readOncallConfig(data.config);

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.alerts.title}
        tabs={buildAlertsTabs("oncall")}
        tools={
          <div className={s.toolRow}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canPageTest || pageTestMut.isPending}
              onClick={() => pageTestMut.mutate(undefined, { onSuccess: (res) => setReceipt(res.action) })}
            >
              {COPY.oncall.pageTestButton}
            </button>
            {!canPageTest ? <DisabledReason reason={COPY.oncall.requiresPageTestGrant} /> : null}
          </div>
        }
      />
      {pageTestMut.error ? <div className={s.feedback}><InlineError error={pageTestMut.error} /></div> : null}
      {receipt ? <div className={s.feedback}><CmdReceipt action={receipt} /></div> : null}

      <StatRow
        items={[
          {
            id: "status",
            label: COPY.oncall.displayStatus,
            value: <ObservedValue observation={data.display_status} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
          },
          {
            id: "lastTestAt",
            label: COPY.oncall.lastPageTest,
            value: <ObservedValue observation={data.last_page_test_at} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatUtcShort(String(v))} />,
          },
          {
            id: "lastTestOk",
            label: COPY.oncall.lastPageOk,
            value: (
              <ObservedValue
                observation={data.last_page_test_ok}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                asBadge
                formatValue={(v) => (v ? COPY.health.boolOk : COPY.health.boolFail)}
              />
            ),
          },
        ]}
      />

      <section className={s.section} aria-labelledby="oncall-config">
        <h2 id="oncall-config" className={s.sectionTitle}>{COPY.oncall.configTitle}</h2>
        {cfg ? (
          <KeyValue
            items={[
              { id: "mode", label: COPY.oncall.fields.mode, value: cfg.mode },
              { id: "tz", label: COPY.oncall.fields.timezone, value: cfg.timezone },
              { id: "primary", label: COPY.oncall.fields.primary, value: <code>{cfg.rotation.primary_person ?? COPY.oncall.fields.unassigned}</code> },
              { id: "backup", label: COPY.oncall.fields.backup, value: <code>{cfg.rotation.backup_person ?? COPY.oncall.fields.unassigned}</code> },
              { id: "handoff", label: COPY.oncall.fields.handoff, value: `${cfg.rotation.handoff_weekday} ${String(cfg.rotation.handoff_hour_local).padStart(2, "0")}:00` },
              { id: "ackTimeout", label: COPY.oncall.fields.ackTimeout, value: formatDuration(cfg.escalation.ack_timeout_s) },
              { id: "repeatInterval", label: COPY.oncall.fields.repeatInterval, value: formatDuration(cfg.escalation.repeat_interval_s) },
              { id: "outOfHours", label: COPY.oncall.fields.outOfHours, value: cfg.escalation.out_of_hours_policy },
              { id: "dailyBudget", label: COPY.oncall.fields.dailyBudget, value: formatCount(cfg.escalation.daily_page_budget) },
              {
                id: "synthetic",
                label: COPY.oncall.fields.syntheticTest,
                value: `${cfg.synthetic_page_test.enabled ? "Enabled" : "Disabled"} · ${cfg.synthetic_page_test.schedule} ${cfg.synthetic_page_test.weekday} ${String(cfg.synthetic_page_test.hour_utc).padStart(2, "0")}:00Z (max lag ${formatDuration(cfg.synthetic_page_test.max_delivery_lag_s)})`,
              },
            ]}
          />
        ) : (
          <p className={s.emptyNote}>{COPY.oncall.configMissing}</p>
        )}
      </section>
    </div>
  );
}
