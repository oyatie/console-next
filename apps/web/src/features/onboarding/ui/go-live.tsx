import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError } from "../api";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { freshOnOpen } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button, Check } from "../../../ui/button/button";
import { SectionHead } from "../../../ui/card/section-head";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { goLive, goLivePreviewQuery, SETUP_READS } from "../api";
import { Blockers, Warnings } from "./go-live-items";
import { onboardingError } from "../present";
import { StatRow } from "../../../ui/key-value/key-value";
import { GoLiveDetails } from "./go-live-details";

/**
 * The one-way start of operations (design §5.4): what still blocks it (each a BlockedPanel with the fix for each record
 * it counts), what to look at, and what becomes governed afterwards. Every count is the server's count of the records it
 * lists (company-49), and the preview re-reads on return from a fix (company-53). Starting is bound to this preview (its
 * digest) and to the actor's passkey; it cannot be undone.
 */
export function GoLive() {
  const q = freshOnOpen(useQuery(goLivePreviewQuery));
  const nav = useNavigate();
  const [ack, setAck] = useState(false);
  const run = useCommand({
    run: (_: undefined, key: string) => goLive(q.data!.digest, ack, q.data!.line_digests, key),
    invalidates: SETUP_READS,
    announce: (r) => t("setup.golive.done", { at: fmtDateTime(r.go_live_at) }),
    onSuccess: () => void nav({ to: "/" }),
  });
  const changed = run.error instanceof ApiError && run.error.code === "preview_stale"
    ? (Array.isArray(run.error.details.changed_codes) ? run.error.details.changed_codes.filter((c): c is string => typeof c === "string") : []) : [];
  const refreshing = q.isFetching || (run.error instanceof ApiError && run.error.code === "preview_stale" && q.dataUpdatedAt <= run.submittedAt);
  return (
    <div className="page">
      <div className="page__head">
        <Link to="/" className="btn btn--ghost">{t("setup.title")}</Link>
        <h1 className="page__title" tabIndex={-1}>{t("setup.golive.title")}</h1>
      </div>
      <QueryState q={q}>
        {(p) => {
          const f = p.facts;
          // The server asks a sole holder to acknowledge only where org changes route through a second person
          // (decisions #26); under the default none there is no approval to be alone in.
          const sole = p.warnings.some((w) => w.code === "sole_holder");
          const start = <Button variant="primary" disabled={run.isPending || refreshing} onClick={() => run.mutate(undefined)}>{t("setup.golive.start")}</Button>;
          return (
            <section className="card panel form">
              <StatRow items={[
                { key: "entities", label: t("setup.golive.details.legal_entity"), value: fmtNumber(f.entities) },
                { key: "workplaces", label: t("setup.golive.details.workplace"), value: fmtNumber(f.workplaces) },
                { key: "units", label: t("setup.golive.details.units"), value: fmtNumber(f.org_units) },
                { key: "people", label: t("setup.stats.people"), value: fmtNumber(f.employees) },
                { key: "later", label: t("setup.golive.later"), value: fmtNumber(f.employees_starting_later) },
                { key: "writes", label: t("setup.bulk.history"), value: fmtNumber(f.setup_writes) },
              ]} />
              <Blockers items={p.blockers} changed={changed} />
              <Warnings items={p.warnings} changed={changed} />
              <GoLiveDetails p={p} changed={changed} />
              <section aria-labelledby="governed">
                <SectionHead level={2} id="governed">{t("setup.golive.governed")}</SectionHead>
                <ul className="steps-plain">{p.becomes_governed.map((code) => <li key={code}>{codeText(`setup.golive.becomes.${code}`, code)}</li>)}</ul>
              </section>
              {sole && <Check checked={ack} onChange={setAck}>{t("setup.golive.soleHolder")}</Check>}
              <ActionBar
                notice={<CommandError error={run.error} own={onboardingError}>{changed.length > 0 && <ul>{changed.map((code) => <li key={code}>{codeText(`setup.golive.changed.${code}`, codeText(`setup.golive.item.${code}`, t("setup.golive.changed")))}</li>)}</ul>}</CommandError>}
                consequence={<>{t("setup.golive.becomes.setup_undo_becomes_correction")} · {t("setup.golive.oneWay")}</>}
                actions={
                  <>
                    <Link to="/" className="btn">{t("common.back")}</Link>
                    {p.blockers.length > 0 || (sole && !ack) || refreshing ? (
                      <DisabledReason
                        layout="inline"
                        reason={refreshing ? t("setup.golive.refreshing") : p.blockers.length > 0 ? t("setup.golive.blocked", { count: p.blockers.length }) : t("setup.golive.ackNeeded")}
                        control={(c) => <Button variant="primary" {...c}>{t("setup.golive.start")}</Button>}
                      />
                    ) : (
                      start
                    )}
                  </>
                }
              />
            </section>
          );
        }}
      </QueryState>
    </div>
  );
}
