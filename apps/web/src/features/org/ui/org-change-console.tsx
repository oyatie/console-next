// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { ORG_CHANGE_STATUS, actor, labeled } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import type { ReadState } from "../../../lib/react/query-view";
import type { useCan } from "../../../reference/authz/ui/use-can";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { GateRail } from "../../../ui/gate-rail";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { DocumentDecision } from "../../../ui/patterns/document-decision";
import { docLinkClass } from "../../../ui/patterns/document-decision-link";
import { DocHeader, DocLinkContent, DocLinkList, DocRailBody, DocRailSection, DocSection } from "../../../ui/patterns/document-decision-parts";
import { type Names } from "../present";
import { ChangeChain } from "./change-chain";
import { ChangePreflight } from "./change-preflight";
import { ChangeSettlement } from "./change-settlement";
import { OrgChangeHistoryTimeline, OrgChangeNextStep, OrgChangeNotices, OrgChangeReceiptDock, ProposalBody } from "./org-change-parts";
import { useOrgChangeRecord } from "./use-org-change-record";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];

export function OrgChangeConsole({
  q,
  n,
  can,
  refetch,
}: {
  q: ReadState<Detail>;
  n: Names;
  can: ReturnType<typeof useCan>;
  refetch: () => Promise<{ data?: Detail }>;
}) {
  const d = q.data;
  const st = useOrgChangeRecord(d, n, can);
  const statusChip = d ? labeled(ORG_CHANGE_STATUS, d.status) : null;
  const decidedCount = d ? d.approvalSteps.filter((x) => x.decision === "APPROVED").length : 0;
  const settledCount = d ? d.settlementItems.filter((x) => x.done).length : 0;

  return (
    <DocumentDecision
      q={q}
      keepOnLoss
      back={{ to: "/org/changes", label: t("structure.tab.changes") }}
      head={{
        title: d ? st.title : t("structure.tab.changes"),
        titleId: "change-title",
        meta: d && statusChip ? (
          <>
            <bdi className="num t-semibold">{d.code}</bdi>
            <Chip tone={statusChip.tone}>{statusChip.label}</Chip>
          </>
        ) : undefined,
        actions: (
          <Link to="/org/changes" className={buttonClass("secondary", { size: "sm" })}>
            {t("structure.tab.changes")}
          </Link>
        ),
      }}
      notes={
        d ? (
          <>
            {st.note && <OrgChangeReceiptDock code={d.code} receipt={st.note} />}
            <OrgChangeNotices
              unsentCount={st.unsent && st.editable && st.report && st.report.blockers.length > 0 ? st.report.blockers.length : 0}
              leftDraftAt={st.leftDraft ? d.updatedAt : null}
            />
            {st.rail && <GateRail steps={st.rail.steps} current={st.rail.current} failed={st.rail.failed} />}
            <CommandError error={st.preflight.error} />
          </>
        ) : undefined
      }
      start={
        d ? (
          <>
            <DocRailSection label={t("approvals.preview.facts")}>
              <PaneHead title={t("approvals.preview.facts")} />
              <DocRailBody>
                <KeyValue
                  density="dense"
                  readOnly
                  items={[
                    { key: "code", label: t("approvals.field.documentNo"), value: d.code },
                    { key: "date", label: t("orgChange.date"), value: fmtDate(d.effectiveDate) },
                    { key: "drafter", label: t("approvals.field.requester"), value: actor(d.draftedByName) },
                    {
                      key: "headcount",
                      label: t("orgChange.headcount"),
                      value: t(d.status === "APPLIED" ? "orgChange.headcount.moved" : "orgChange.headcount.value", { count: st.report?.headcount ?? d.headcount }),
                    },
                  ]}
                />
              </DocRailBody>
            </DocRailSection>
            {d.approvalSteps.length > 0 && (
              <DocRailSection label={t("orgChange.chain.title", { n: decidedCount, total: d.approvalSteps.length })}>
                <PaneHead title={t("orgChange.chain.title", { n: decidedCount, total: d.approvalSteps.length })} />
                <DocRailBody>
                  <ChangeChain d={d} flat />
                </DocRailBody>
              </DocRailSection>
            )}
            {d.events.length > 0 && (
              <DocRailSection label={t("orgChange.history")}>
                <PaneHead
                  title={t("orgChange.history")}
                  actions={st.place && <Link to="/org" search={st.place}>{t("orgChange.openUnit")}</Link>}
                />
                <DocRailBody>
                  <OrgChangeHistoryTimeline events={d.events} />
                </DocRailBody>
              </DocRailSection>
            )}
          </>
        ) : undefined
      }
      document={
        d ? (
          <>
            <DocHeader
              kicker={d.code}
              title={st.title}
              meta={[
                `${t("approvals.field.requester")} ${actor(d.draftedByName)}`,
                `${t("approvals.field.requestedAt")} ${fmtDate(d.createdAt.slice(0, 10))}`,
                `${t("orgChange.date")} ${fmtDate(d.effectiveDate)}`,
              ].join(" · ")}
            />
            <DocSection label={t("orgChange.proposal")} title={t("orgChange.proposal")}>
              <ProposalBody d={d} n={n} headcount={st.report?.headcount ?? d.headcount} flat />
            </DocSection>
            {st.report && (
              <DocSection label={t("orgChange.preflight")} title={t("orgChange.preflight")}>
                <ChangePreflight
                  d={d}
                  report={st.report}
                  checking={st.preflight.isPending}
                  onRerun={() => st.preflight.mutate(undefined)}
                  onEdit={() => st.setEditing(true)}
                  flat
                />
              </DocSection>
            )}
            {d.settlementItems.length > 0 && (
              <DocSection
                label={t("orgChange.settle.title", { n: settledCount, total: d.settlementItems.length })}
                title={t("orgChange.settle.title", { n: settledCount, total: d.settlementItems.length })}
              >
                <ChangeSettlement d={d} refetch={refetch} onNote={st.show} flat />
              </DocSection>
            )}
          </>
        ) : undefined
      }
      decisionLabel={t("orgChange.next.title")}
      decision={
        d && st.s ? (
          <>
            <PaneHead title={t("orgChange.next.title")} />
            <DocRailBody>
              <div className={css.next}>
                <OrgChangeNextStep d={d} st={st} n={n} refetch={refetch} flat />
                {d.status === "IN_APPROVAL" && st.s.kind !== "decide" && (!d.sole_holder_decision || Boolean(st.note?.hold)) && (
                  <div className={css.bar}>
                    <Link to="/approvals/$approvalId" params={{ approvalId: `org_change:${d.id}` }} className={buttonClass("primary")}>
                      {t("orgChange.openApproval")}
                    </Link>
                  </div>
                )}
              </div>
            </DocRailBody>
            <DocRailSection label={t("approvals.related.title")}>
              <PaneHead title={t("approvals.related.title")} meta={t("approvals.related.meta")} level={3} />
              <DocLinkList>
                {st.place && (
                  <Link to="/org" search={st.place} className={docLinkClass}>
                    <DocLinkContent kind={t("shell.link.org")} label={t("orgChange.openUnit")} />
                  </Link>
                )}
                <Link to="/org" search={{ tab: "changes" }} className={docLinkClass}>
                  <DocLinkContent kind={t("structure.tab.changes")} label={t("orgChange.list.title")} />
                </Link>
              </DocLinkList>
            </DocRailSection>
          </>
        ) : undefined
      }
      statusSegments={
        d && statusChip
          ? [
              { id: "code", tone: "strong", content: d.code },
              { id: "status", content: statusChip.label },
              { id: "effective", content: fmtDate(d.effectiveDate) },
            ]
          : undefined
      }
    />
  );
}
