// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsHome, OpsApiError, opsQueryKeys, readObservedReason, readObservedValue, type OpsHealth } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtColon, fmtJoin, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { Badge, type BadgeTone } from "../ui/badge";
import { CompactTable } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { PageHead } from "../ui/page-head";
import { getStaleClientTag, isLiveDisconnected } from "../ui/stale-tag";
import { buildChangingColumns, buildWorkColumns } from "./now-columns";
import { NowLowerSections } from "./now-sections";
import s from "./now-screen.module.css";

function healthTone(health: OpsHealth): BadgeTone {
  if (health === "Healthy") return "ok";
  if (health === "Progressing") return "info";
  if (health === "Degraded" || health === "Suspended") return "warn";
  if (health === "Missing") return "danger";
  return "unknown";
}

export function NowScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.home");

  const query = useQuery({
    queryKey: opsQueryKeys.home,
    queryFn: fetchOpsHome,
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
            message: "Home snapshot requires read.home permission.",
            support_ref: "cedar-home",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.now.title} meta={COPY.loading.nowTitle} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const home = query.data;
  const evaluatedAt = formatUtcTimestamp(home.evaluated_at);
  const verdictText = home.verdict.text.trim() || COPY.now.quietVerdict;
  const disconnected = isLiveDisconnected(live.status);
  const staleTag = getStaleClientTag(live.status, live.disconnectedAgeS);
  const workCols = buildWorkColumns(live.status, live.disconnectedAgeS);
  const changingCols = buildChangingColumns(live.status, live.disconnectedAgeS);

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.now.title}
        meta={<span className={s.verdictMeta}>{fmtColon(COPY.status.evaluatedAt, evaluatedAt)}</span>}
      />

      <section className={s.verdictBand} aria-label={COPY.now.verdictLabel}>
        {disconnected ? (
          <>
            <Badge tone="unknown">{staleTag}</Badge>
            <p className={s.verdictText}>
              <s className={s.struckText}>{home.verdict.worst}</s>{" "}
              <s className={s.struckText}>{verdictText}</s>
            </p>
          </>
        ) : (
          <>
            <Badge tone={healthTone(home.verdict.worst)}>{home.verdict.worst}</Badge>
            <p className={s.verdictText}>{verdictText}</p>
          </>
        )}
      </section>

      <section className={s.band} aria-labelledby="now-worklist">
        <div className={s.bandHead}>
          <h2 id="now-worklist" className={s.bandTitle}>{COPY.now.worklistTitle}</h2>
        </div>
        {home.worklist.length > 0 ? (
          <CompactTable
            caption={COPY.now.worklistTitle}
            rows={home.worklist}
            rowKey={(r) => `${r.kind}-${String(readObservedValue(r.title) ?? readObservedReason(r.title) ?? "")}-${r.next.href}`}
            columns={workCols}
          />
        ) : (
          <p className={s.emptyNote}>{fmtJoin(COPY.now.worklistEmpty, evaluatedAt)}</p>
        )}
      </section>

      <section className={s.band} aria-labelledby="now-changing">
        <div className={s.bandHead}>
          <h2 id="now-changing" className={s.bandTitle}>{COPY.now.changingTitle}</h2>
        </div>
        {home.changing.length > 0 ? (
          <CompactTable
            caption={COPY.now.changingTitle}
            rows={home.changing}
            rowKey={(r) => r.key}
            columns={changingCols}
          />
        ) : (
          <p className={s.emptyNote}>{fmtJoin(COPY.now.changingEmpty, evaluatedAt)}</p>
        )}
      </section>

      <NowLowerSections
        home={home}
        liveStatus={live.status}
        disconnectedAgeS={live.disconnectedAgeS}
        evaluatedAt={evaluatedAt}
      />
    </div>
  );
}
