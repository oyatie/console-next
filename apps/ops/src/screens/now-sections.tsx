// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { COPY } from "../copy";
import { readObservedValue, type OpsHomeSnapshot, type OpsLive } from "../lib/api";
import { fmtJoin, formatCount, formatDuration, formatUsd } from "../lib/format";
import { Badge } from "../ui/badge";
import { CompactTable } from "../ui/compact-table";
import { Meter } from "../ui/meter";
import { ObservedValue } from "../ui/observed-value";
import { getStaleClientTag, isLiveDisconnected } from "../ui/stale-tag";
import { StatRow } from "../ui/stat-row";
import { buildBudgetColumns, buildEvidenceSourceColumns, buildSafetyColumns } from "./now-lower-columns";
import s from "./now-screen.module.css";

export function NowLowerSections({
  home,
  liveStatus,
  disconnectedAgeS,
  evaluatedAt,
}: {
  home: OpsHomeSnapshot;
  liveStatus: OpsLive;
  disconnectedAgeS: number;
  evaluatedAt: string;
}) {
  const disconnected = isLiveDisconnected(liveStatus);
  const staleTag = getStaleClientTag(liveStatus, disconnectedAgeS);
  const budgetCols = buildBudgetColumns(liveStatus, disconnectedAgeS);
  const safetyCols = buildSafetyColumns(liveStatus, disconnectedAgeS);
  const sourceCols = buildEvidenceSourceColumns(liveStatus, disconnectedAgeS);

  const evCounts = home.evidence.counts;
  const renderEvCount = (n: number, isUnknownBucket = false) =>
    disconnected && !isUnknownBucket ? (
      <span className={s.staleWrap}>
        <s className={s.struckText}>{formatCount(n)}</s>
        <Badge tone="unknown">{staleTag}</Badge>
      </span>
    ) : (
      formatCount(n)
    );

  return (
    <div className={s.splitGrid}>
      <section className={s.splitCell} aria-labelledby="now-budgets">
        <div className={s.bandHead}>
          <h2 id="now-budgets" className={s.bandTitle}>{COPY.now.budgetsTitle}</h2>
        </div>
        {home.budgets.length > 0 ? (
          <CompactTable
            caption={COPY.now.budgetsTitle}
            rows={home.budgets}
            rowKey={(r) => r.key}
            columns={budgetCols}
          />
        ) : (
          <p className={s.emptyNote}>{fmtJoin(COPY.now.budgetsEmpty, evaluatedAt)}</p>
        )}
      </section>

      <section className={s.splitCell} aria-labelledby="now-safety">
        <div className={s.bandHead}>
          <h2 id="now-safety" className={s.bandTitle}>{COPY.now.dataSafetyTitle}</h2>
        </div>
        {home.data_safety.length > 0 ? (
          <CompactTable
            caption={COPY.now.dataSafetyTitle}
            rows={home.data_safety}
            rowKey={(r) => r.repository}
            columns={safetyCols}
          />
        ) : (
          <p className={s.emptyNote}>{fmtJoin(COPY.now.dataSafetyEmpty, evaluatedAt)}</p>
        )}
      </section>

      <section className={s.splitCell} aria-labelledby="now-cost">
        <div className={s.bandHead}>
          <h2 id="now-cost" className={s.bandTitle}>{COPY.now.costTitle}</h2>
        </div>
        {home.cost.length > 0 ? (
          <div className={s.costBlock}>
            {home.cost.map((c) => (
              <div key={c.key} className={s.costEntry}>
                <div className={s.costRow}>
                  <strong>{c.key}</strong>
                  <span className={s.costMetric}>
                    <span>{fmtJoin(COPY.now.cols.mtd, ":")}</span>
                    <ObservedValue
                      observation={c.mtd}
                      liveStatus={liveStatus}
                      disconnectedAgeS={disconnectedAgeS}
                      formatValue={(v) => formatUsd(Number(v))}
                    />
                  </span>
                  <span className={s.costMetric}>
                    <span>{fmtJoin(COPY.now.cols.lag, ":")}</span>
                    <ObservedValue
                      observation={c.lag_s}
                      liveStatus={liveStatus}
                      disconnectedAgeS={disconnectedAgeS}
                      formatValue={(v) => formatDuration(Number(v))}
                    />
                  </span>
                  <span className={s.costMetric}>
                    <span>{fmtJoin(COPY.now.cols.skus, ":")}</span>
                    <ObservedValue
                      observation={c.billed_skus}
                      liveStatus={liveStatus}
                      disconnectedAgeS={disconnectedAgeS}
                      formatValue={(v) => formatCount(Number(v))}
                    />
                  </span>
                </div>
                {c.limits.length > 0 ? (
                  <div className={s.meterList}>
                    {c.limits.map((lim) => {
                      const rawUsed = readObservedValue(lim.used);
                      const rawLimit = readObservedValue(lim.limit);
                      const rawWarn = readObservedValue(lim.warning_ratio);
                      const hasKnownMeter =
                        lim.used.state !== "Unknown" &&
                        lim.limit.state !== "Unknown" &&
                        typeof rawUsed === "number" &&
                        Number.isFinite(rawUsed) &&
                        typeof rawLimit === "number" &&
                        Number.isFinite(rawLimit) &&
                        rawLimit > 0;

                      if (hasKnownMeter) {
                        const ratio = rawUsed / rawLimit;
                        const warnAt = typeof rawWarn === "number" ? rawWarn : 0.8;
                        return (
                          <div key={lim.key} className={s.meterItem}>
                            <span className={s.meterKey}>{lim.key}</span>
                            <Meter
                              value={rawUsed}
                              max={rawLimit}
                              label={lim.key}
                              warn={ratio >= warnAt && ratio < 1}
                              danger={ratio >= 1}
                              valueText={`${formatCount(rawUsed)} / ${formatCount(rawLimit)}`}
                            />
                            <ObservedValue
                              observation={lim.used}
                              liveStatus={liveStatus}
                              disconnectedAgeS={disconnectedAgeS}
                              formatValue={(v) => `${formatCount(Number(v))} / ${formatCount(rawLimit)}`}
                            />
                          </div>
                        );
                      }

                      return (
                        <div key={lim.key} className={s.meterItem}>
                          <span className={s.meterKey}>{lim.key}</span>
                          <span className={s.meterUnknownPair}>
                            <ObservedValue
                              observation={lim.used}
                              liveStatus={liveStatus}
                              disconnectedAgeS={disconnectedAgeS}
                              formatValue={(v) => formatCount(Number(v))}
                            />
                            <span> / </span>
                            <ObservedValue
                              observation={lim.limit}
                              liveStatus={liveStatus}
                              disconnectedAgeS={disconnectedAgeS}
                              formatValue={(v) => formatCount(Number(v))}
                            />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className={s.emptyNote}>{fmtJoin(COPY.now.costEmpty, evaluatedAt)}</p>
        )}
      </section>

      <section className={s.splitCell} aria-labelledby="now-evidence">
        <div className={s.bandHead}>
          <h2 id="now-evidence" className={s.bandTitle}>{COPY.now.evidenceTitle}</h2>
          <Link to="/sources" className={s.bandLink}>{COPY.now.viewSources}</Link>
        </div>
        <StatRow
          items={[
            { id: "v", label: COPY.now.verifiedLabel, value: renderEvCount(evCounts.Verified), tone: !disconnected && evCounts.Verified > 0 ? "ok" : "default" },
            { id: "m", label: COPY.now.monitoringLabel, value: renderEvCount(evCounts.Monitoring), tone: !disconnected && evCounts.Monitoring > 0 ? "primary" : "default" },
            { id: "s", label: COPY.now.staleLabel, value: renderEvCount(evCounts.Stale), tone: !disconnected && evCounts.Stale > 0 ? "warn" : "default" },
            { id: "u", label: COPY.now.unknownLabel, value: renderEvCount(evCounts.Unknown, true), tone: evCounts.Unknown > 0 ? "danger" : "default" },
          ]}
        />
        {home.evidence.sources.length > 0 ? (
          <CompactTable
            caption={COPY.now.evidenceTitle}
            rows={home.evidence.sources}
            rowKey={(r) => r.name}
            columns={sourceCols}
          />
        ) : (
          <p className={s.emptyNote}>{COPY.now.evidenceAllFresh}</p>
        )}
      </section>
    </div>
  );
}
