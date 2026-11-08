// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
// eslint-disable-next-line no-restricted-imports -- Go-live synchronizes the server-confirmed phase before navigation.
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError } from "../api";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { freshOnOpen } from "../../../lib/query";
import { meQuery } from "../../account/api";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { StatRow } from "../../../ui/key-value/key-value";
import { goLive, goLivePreviewQuery, goLiveReceiptQuery, SETUP_READS, type GoLiveFactsSnapshot } from "../api";
import { Blockers, Warnings } from "./go-live-items";
import { onboardingError } from "../present";
import { GoLiveDetails } from "./go-live-details";
import s from "./go-live.module.css";

/**
 * The one-way start of operations (design §5.4, ideal-v2 §4): compact blockers with direct fixes, what to look at, and
 * what becomes governed afterwards; once operating, the receipt separates recorded counts from current configuration.
 */
export function GoLive() {
  const q = freshOnOpen(useQuery(goLivePreviewQuery));
  const receipt = useQuery({ ...goLiveReceiptQuery, enabled: q.data?.phase === "OPERATING" });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [acknowledgedDigest, setAcknowledgedDigest] = useState<string | null>(null);
  const ack = acknowledgedDigest === q.data?.digest;
  const refreshFailed = q.data?.phase === "SETUP" && queryView(q) === "stale";
  const run = useCommand({
    run: (_: undefined, key: string) => goLive(q.data!.digest, ack, q.data!.line_digests, key),
    // Freeze the destination rail only after its server readiness includes this command.
    invalidates: ["/api/v1/onboarding/modules", ...SETUP_READS],
    awaitFirstRead: true,
    announce: (r) => t("setup.golive.done", { at: fmtDateTime(r.go_live_at) }),
    onSuccess: (result) => {
      // The command's answer updates the rail before a slower profile refetch can move its entries.
      qc.setQueriesData(meQuery, (meData: Awaited<ReturnType<typeof meQuery.queryFn>> | undefined) => meData?.tenant ? {
        ...meData, tenant: { ...meData.tenant, phase: result.phase, go_live_at: result.go_live_at },
      } : meData);
      void nav({ to: "/" });
    },
  });
  const changed = run.error instanceof ApiError && run.error.code === "preview_stale"
    ? (Array.isArray(run.error.details.changed_codes) ? run.error.details.changed_codes.filter((c): c is string => typeof c === "string") : []) : [];
  const refreshing = q.isError || q.isFetching || (run.error instanceof ApiError && run.error.code === "preview_stale" && q.dataUpdatedAt <= run.submittedAt);
  const operating = q.data?.phase === "OPERATING";
  return (
    <div className="page">
      <div className="page__head">
        <Link to="/" className={buttonClass("ghost")}>{t(operating ? "shell.link.home" : "setup.title")}</Link>
        <h1 className="page__title" tabIndex={-1}>{t("setup.golive.title")}</h1>
      </div>
      {/* Cached-read recovery belongs beside the sticky launch action; refusals remain with QueryState. */}
      <QueryState q={refreshFailed ? { ...q, error: null } : q}>
        {(p) => {
          const stats = (f: GoLiveFactsSnapshot) => [
            { key: "entities", label: t("setup.golive.details.legal_entity"), value: fmtNumber(f.entities) },
            { key: "workplaces", label: t("setup.golive.details.workplace"), value: fmtNumber(f.workplaces) },
            { key: "registration-todo", label: t("setup.golive.registrationTodo"), value: fmtNumber(f.staffed_workplaces_without_registration + f.empty_workplaces_without_registration) },
            { key: "units", label: t("setup.golive.details.units"), value: fmtNumber(f.org_units) },
            { key: "people", label: t("setup.stats.people"), value: fmtNumber(f.employees) },
            { key: "later", label: t("setup.golive.later"), value: fmtNumber(f.employees_starting_later) },
            { key: "writes", label: t("setup.bulk.history"), value: fmtNumber(f.setup_writes) },
          ];
          const governed = (
            <Card title={t(operating ? "setup.receipt.governed" : "setup.golive.governed")} titleId="governed">
              <div className={s.stack}>
                <ul className="steps-plain">{p.becomes_governed.map((code) => {
                  const text = codeText(`setup.golive.becomes.${code}`, code);
                  return <li key={code}>{operating ? codeText(`setup.receipt.applied.${code}`, text) : text}</li>;
                })}</ul>
              </div>
            </Card>
          );
          if (p.phase === "OPERATING") {
            return (
              <>
                <QueryState q={receipt} own={onboardingError}>
                  {(record) => <Card title={t(record.facts_snapshot === null ? "setup.receipt.unrecorded" : record.facts_snapshot_version === 1 ? "setup.receipt.recorded" : "setup.receipt.unsupported")}>
                    <div className={s.stack}>
                      <div className={s.receiptHead}>
                        <Chip tone="ok">{t("setup.receipt.started.title")}</Chip>
                        <time dateTime={record.go_live_at}>{fmtDateTime(record.go_live_at)}</time>
                      </div>
                      {record.facts_snapshot !== null && record.facts_snapshot_version === 1 && <StatRow items={stats(record.facts_snapshot)} />}
                    </div>
                  </Card>}
                </QueryState>
                <div className={s.layout}>
                  <Card title={t("setup.receipt.liveDetails")}><div className={s.body}><GoLiveDetails p={p} /></div></Card>
                  {governed}
                </div>
                <ActionBar
                  sticky
                  consequence={t("setup.receipt.started.detail")}
                  actions={
                    <>
                      <Link to="/org/history" className={buttonClass()}>{t("setup.bulk.history")}</Link>
                      <Link to="/" className={buttonClass("primary")}>{t("shell.link.home")}</Link>
                    </>
                  }
                />
              </>
            );
          }
          // The server asks a sole holder to acknowledge only where org changes route through a second person
          // (decisions #26); under the default none there is no approval to be alone in.
          const sole = p.warnings.some((w) => w.code === "sole_holder");
          const start = <Button variant="primary" disabled={run.isPending || refreshing} onClick={() => run.mutate(undefined)}>{t("setup.golive.start")}</Button>;
          return (
            <>
              <Card><StatRow items={stats(p.facts)} /></Card>
              <div className={s.layout}>
                <Card>
                  <div className={s.body}>
                    <Blockers items={p.blockers} changed={changed} />
                    <Warnings items={p.warnings} changed={changed} />
                    <GoLiveDetails p={p} changed={changed} />
                  </div>
                </Card>
                {governed}
              </div>
              <ActionBar
                sticky
                notice={<>
                  {refreshFailed && <QueryState q={q} inline own={() => t("setup.golive.refreshFailed")}>{() => null}</QueryState>}
                  <CommandError error={run.error} own={onboardingError}>{changed.length > 0 && <ul>{changed.map((code) => <li key={code}>{codeText(`setup.golive.changed.${code}`, codeText(`setup.golive.item.${code}`, t("setup.golive.changed")))}</li>)}</ul>}</CommandError>
                </>}
                consequence={<>{sole && <Check checked={ack} onChange={(checked) => setAcknowledgedDigest(checked ? p.digest : null)}>{t("setup.golive.soleHolder")}</Check>}{t("setup.golive.becomes.setup_undo_becomes_correction")} · {t("setup.golive.oneWay")}</>}
                actions={
                  <>
                    <Link to="/" className={buttonClass()}>{t("common.back")}</Link>
                    {p.blockers.length > 0 || (sole && !ack) || refreshing ? (
                      <DisabledReason
                        reason={q.isError ? t("setup.golive.refreshFailed") : refreshing ? t("setup.golive.refreshing") : p.blockers.length > 0 ? t("setup.golive.blocked", { count: p.blockers.length }) : t("setup.golive.ackNeeded")}
                        control={(c) => <Button variant="primary" {...c}>{t("setup.golive.start")}</Button>}
                      />
                    ) : (
                      start
                    )}
                  </>
                }
              />
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
