// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { COPY } from "../copy";
import { fetchOpsAlertDetail, opsQueryKeys, readObservedValue, type OpsLive } from "../lib/api";
import { classifyOpsError } from "../lib/auth";
import { fmtCountLabel, fmtJoin, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { ExternalUrl } from "../ui/external-url";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import s from "./alerts-screen.module.css";

export function AlertDetailPane({
  groupKey,
  liveStatus,
  disconnectedAgeS,
  closeHref,
  isMobileFull,
}: {
  groupKey: string;
  liveStatus: OpsLive;
  disconnectedAgeS: number;
  closeHref: string;
  isMobileFull?: boolean;
}) {
  const query = useQuery({
    queryKey: opsQueryKeys.alertDetail(groupKey),
    queryFn: () => fetchOpsAlertDetail(groupKey),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (query.isPending) {
    return <p className={s.emptyNote}>{COPY.loading.alertDetailTitle}</p>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const g = query.data.group;
  const vvt = g.value_vs_threshold;

  return (
    <div className={s.detailStack}>
      {isMobileFull ? (
        <div className={s.mobileBack}>
          <Link to={closeHref} className="btn btn--sm">
            <ArrowLeft size={12} aria-hidden="true" />
            <span>{COPY.alerts.backToAlerts}</span>
          </Link>
        </div>
      ) : null}

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.summary}</h3>
        <div className={s.detailBody}>
          <ObservedValue observation={g.summary} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        </div>
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.impact}</h3>
        <div className={s.detailBody}>
          <ObservedValue observation={g.impact} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        </div>
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.valueAndSince}</h3>
        <div className={s.detailBody}>
          <ObservedValue observation={vvt.value} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
          <span> </span>
          <ObservedValue observation={vvt.operator} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
          <span> </span>
          <ObservedValue observation={vvt.threshold} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
          <span> · </span>
          <ObservedValue
            observation={g.since}
            liveStatus={liveStatus}
            disconnectedAgeS={disconnectedAgeS}
            formatValue={(v) => formatUtcTimestamp(String(v))}
          />
        </div>
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.probableCause}</h3>
        <div className={s.detailBody}>
          <ObservedValue observation={g.probable_cause} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        </div>
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.firstAction}</h3>
        <div className={s.detailBody}>
          <ObservedValue observation={g.first_action} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        </div>
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{fmtCountLabel(COPY.alerts.detail.notices, g.notices.length)}</h3>
        {g.notices.length > 0 ? (
          <ul className={s.detailList}>
            {g.notices.map((n, idx) => (
              <li key={idx}>
                <ObservedValue observation={n} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.detailBody}>{COPY.alerts.detail.noNotices}</p>
        )}
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.rule}</h3>
        <code className={s.codeBlock}>
          <ObservedValue observation={g.rule.expression} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        </code>
        <div className={s.detailBody}>
          <span>{fmtJoin(COPY.alerts.detail.ruleValue, ": ")}</span>
          <ObservedValue observation={g.rule.current_value} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        </div>
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{fmtCountLabel(COPY.alerts.detail.members, g.members.length)}</h3>
        {g.members.length > 0 ? (
          <ul className={s.detailList}>
            {g.members.map((m) => (
              <li key={m.fingerprint} className={s.memberRow}>
                <div className={s.memberHead}>
                  <code>{m.fingerprint}</code>
                  <ObservedValue observation={m.state} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} asBadge />
                </div>
                <div>
                  {Object.entries(m.labels).map(([k, v]) => `${k}=${v}`).join(" · ")}
                </div>
                <ObservedValue
                  observation={m.since}
                  liveStatus={liveStatus}
                  disconnectedAgeS={disconnectedAgeS}
                  formatValue={(v) => formatUtcShort(String(v))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.detailBody}>{COPY.alerts.detail.noMembers}</p>
        )}
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.changes}</h3>
        {g.changes.length > 0 ? (
          <ul className={s.detailList}>
            {g.changes.map((ch, idx) => (
              <li key={idx} className={s.detailBody}>
                <ObservedValue
                  observation={ch.at}
                  liveStatus={liveStatus}
                  disconnectedAgeS={disconnectedAgeS}
                  formatValue={(v) => formatUtcShort(String(v))}
                />
                <span> · </span>
                <ObservedValue observation={ch.summary} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.detailBody}>{COPY.alerts.detail.noChanges}</p>
        )}
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.links}</h3>
        {g.links.length > 0 ? (
          <ul className={s.detailList}>
            {g.links.map((lnk, idx) => {
              const linkVal = readObservedValue(lnk);
              return (
                <li key={idx}>
                  {typeof linkVal === "string" && lnk.state !== "Unknown" ? (
                    <ExternalUrl value={linkVal} />
                  ) : (
                    <ObservedValue observation={lnk} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={s.detailBody}>{COPY.alerts.detail.noLinks}</p>
        )}
      </div>

      <div className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.alerts.detail.footerKey}</h3>
        <code className={s.footerKey}>{g.footer_key}</code>
      </div>
    </div>
  );
}

export function AlertDetailCloseButton({ to }: { to: string }) {
  return (
    <Link to={to} className={`btn btn--sm ${s.desktopClose}`} aria-label={COPY.alerts.closeDetail}>
      <X size={12} aria-hidden="true" />
      <span>{COPY.alerts.closeDetail}</span>
    </Link>
  );
}
