// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsSilences, OpsApiError, opsQueryKeys, type OpsSilences } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtJoin, formatCount, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useCreateSilenceMutation, useExpireSilenceMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { hasWatchdogMatcher, parseMatcherLines, validateSilenceDraft } from "../lib/validation";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import { buildAlertsTabs } from "./hub-tabs";
import s from "./alerts-screen.module.css";

type SilenceRow = OpsSilences["silences"][number];

function futureUtcZ(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatMatcherDefaults(raw: readonly string[] | undefined): string {
  if (!raw || raw.length === 0) return "";
  return raw.map((item) => item.replace(/="([^"]*)"/, "=$1")).join("\n");
}

export function SilencesTab({
  initialMatchers,
  openCreate,
}: {
  initialMatchers?: readonly string[];
  openCreate?: boolean;
}) {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.alerts");
  const canSilence = hasOpsAction(me, "alert.silence");

  const [createOpen, setCreateOpen] = useState(Boolean(openCreate || (initialMatchers && initialMatchers.length > 0)));
  const [matchersText, setMatchersText] = useState(() => formatMatcherDefaults(initialMatchers));
  const [ttlHours, setTtlHours] = useState(4);
  const [endsAt, setEndsAt] = useState(() => futureUtcZ(4));
  const [comment, setComment] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const createMut = useCreateSilenceMutation();
  const expireMut = useExpireSilenceMutation();

  const query = useQuery({
    queryKey: opsQueryKeys.silences,
    queryFn: fetchOpsSilences,
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
            message: "Silences view requires read.alerts permission.",
            support_ref: "cedar-alerts",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className={s.page}>
        <PageHead title={COPY.alerts.title} meta={COPY.loading.silencesTitle} tabs={buildAlertsTabs("silences")} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const evaluatedAt = formatUtcTimestamp(data.evaluated_at);
  const parsedMatchers = parseMatcherLines(matchersText);
  const watchdogBlocked = hasWatchdogMatcher(parsedMatchers);

  const submitCreate = (ev: React.FormEvent) => {
    ev.preventDefault();
    setValidationError(null);
    const err = validateSilenceDraft({
      matchers: parsedMatchers,
      endsAt,
      comment,
      maxHours: 72,
    });
    if (err) {
      setValidationError(err);
      return;
    }
    createMut.mutate(
      { matchers: parsedMatchers, ends_at: endsAt.trim(), comment: comment.trim(), group_key: null },
      {
        onSuccess: () => {
          setComment("");
          setCreateOpen(false);
        },
      },
    );
  };

  const cols: readonly TableColumn<SilenceRow>[] = [
    { id: "id", header: COPY.alerts.silences.id, mobileSlot: "badge", nowrap: true, render: (r) => <code>{r.id}</code> },
    {
      id: "matchers",
      header: COPY.alerts.silences.matchers,
      mobileSlot: "title",
      render: (r) => r.matchers.map((m) => `${m.name}${m.is_equal ? (m.is_regex ? "=~" : "=") : (m.is_regex ? "!~" : "!=")}${m.value}`).join(", "),
    },
    {
      id: "ends",
      header: COPY.alerts.silences.ends,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.ends}
          liveStatus={live.status}
          disconnectedAgeS={live.disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "author",
      header: COPY.alerts.silences.author,
      nowrap: true,
      render: (r) => <ObservedValue observation={r.author} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
    },
    {
      id: "comment",
      header: COPY.alerts.silences.comment,
      render: (r) => <ObservedValue observation={r.comment} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
    },
    {
      id: "action",
      header: COPY.alerts.silences.action,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={!canSilence || expireMut.isPending}
          title={!canSilence ? COPY.alertActions.requiresSilenceGrant : undefined}
          onClick={() => expireMut.mutate(r.id)}
        >
          {COPY.alertActions.expireButton}
        </button>
      ),
    },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.alerts.title}
        tabs={buildAlertsTabs("silences")}
        tools={
          <div className={s.actionBar}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canSilence}
              onClick={() => setCreateOpen((p) => !p)}
            >
              {COPY.alertActions.silenceTabCreate}
            </button>
            {!canSilence ? <DisabledReason reason={COPY.alertActions.requiresSilenceGrant} /> : null}
          </div>
        }
      />
      {expireMut.error ? <div className={s.formPanel}><InlineError error={expireMut.error} /></div> : null}
      {createOpen ? (
        <form className={s.formPanel} onSubmit={submitCreate}>
          <div className={s.presetRow}>
            <button
              type="button"
              className="btn btn--sm"
              aria-pressed={ttlHours === 4}
              onClick={() => {
                setTtlHours(4);
                setEndsAt(futureUtcZ(4));
              }}
            >
              {COPY.alertActions.silenceTtl4h}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              aria-pressed={ttlHours === 72}
              onClick={() => {
                setTtlHours(72);
                setEndsAt(futureUtcZ(72));
              }}
            >
              {COPY.alertActions.silenceTtl72h}
            </button>
          </div>
          <label className={s.fieldLabel}>
            <span>{COPY.alertActions.silenceMatchLabel}</span>
            <textarea
              className="field-textarea"
              value={matchersText}
              onChange={(e) => setMatchersText(e.target.value)}
            />
          </label>
          <label className={s.fieldLabel}>
            <span>{COPY.alertActions.silenceCustomEndsAt}</span>
            <input type="text" className="field-input--form" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </label>
          <label className={s.fieldLabel}>
            <span>{COPY.alertActions.silenceCommentLabel}</span>
            <textarea
              className="field-textarea"
              placeholder={COPY.alertActions.silenceCommentPlaceholder}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          {watchdogBlocked ? <DisabledReason reason={COPY.alertActions.silenceWatchdogReason} /> : null}
          {validationError ? <p className={s.validationText} role="alert">{validationError}</p> : null}
          {createMut.error ? <InlineError error={createMut.error} /> : null}
          <div className={s.actionBar}>
            <button type="submit" className="btn btn--sm btn--primary" disabled={createMut.isPending || !canSilence || watchdogBlocked}>
              {COPY.alertActions.silenceSubmit}
            </button>
          </div>
        </form>
      ) : null}
      <StatRow
        items={[
          {
            id: "count",
            label: COPY.alerts.silences.countLabel,
            value: (
              <ObservedValue
                observation={data.count}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                formatValue={(v) => formatCount(Number(v))}
              />
            ),
          },
        ]}
      />
      {data.silences.length > 0 ? (
        <CompactTable caption={COPY.alerts.silencesTab} rows={data.silences} rowKey={(r) => r.id} columns={cols} />
      ) : (
        <p className={s.emptyNote}>{fmtJoin(COPY.alerts.silences.empty, evaluatedAt)}</p>
      )}
    </div>
  );
}
