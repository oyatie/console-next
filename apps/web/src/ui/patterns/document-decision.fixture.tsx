// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { ChainStepper } from "../chain-stepper/chain-stepper";
import { ChangeRows } from "../change-rows/change-rows";
import { Chip } from "../chip";
import { DecisionPane } from "../decision-pane/decision-pane";
import { KeyValue } from "../key-value/key-value";
import { PaneHead } from "../pane-grid/pane-grid";
import { RecordRows } from "../record/rows";
import { Sheet } from "../sheet/sheet";
import { DocumentDecision } from "./document-decision";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { id: "OC-2026-0418" }, refetch() {} };

/** Synthetic no-network showcase for DocumentDecision (`P4`). */
export default function DocumentDecisionExample({ q = READY }: { q?: ReadState }) {
  const [opinion, setOpinion] = useState("");
  const [outcome, setOutcome] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  const headRef = `OC-2026-0418 · ${t("orgChange.subject")}`;
  const docMeta = `${t("home.decide.drafter", { name: tg("facts.repValue") })} · ${t("approvals.field.requestedAt")} 2026-11-06 · ${t("orgChange.date")} 2026-11-17`;
  const sec1Title = `1. ${t("orgChange.proposal")}`;
  const sec2Title = `2. ${t("empCard.spine.acts")}`;
  const sec3Title = `3. ${t("orgChange.reason")}`;
  const sec4Title = `4. ${t("home.worklist.impact.title")}`;
  const dueMeta = `${t("approvals.field.dueAt")} 11-12 · D-2`;
  const linkTransfer = `${t("home.worklist.impact.transfer")} · ${t("home.worklist.personCount", { count: 12 })}`;
  const linkTeam = `${tg("sample.team")} (${t("enum.unitStatus.DISSOLVED")})`;

  return (
    <DocumentDecision
      q={q}
      head={{
        title: t("approvals.title"),
        titleId: "doc-decision-title",
        filters: <Chip>{t("orgChange.chain.title", { n: 2, total: 3 })}</Chip>,
        meta: <bdi>{headRef}</bdi>,
        actions: (
          <Button size="sm" variant="secondary" onClick={() => setHistoryOpen(true)}>
            {t("orgChange.list.title")}
          </Button>
        ),
      }}
      start={
        <>
          <div className={fx.railSection}>
            <PaneHead title={t("approvals.preview.facts")} />
            <div className={fx.railBody}>
              <KeyValue
                density="dense"
                items={[
                  { key: "ref", label: t("approvals.field.documentNo"), value: "OC-2026-0418" },
                  { key: "kind", label: t("approvals.col.source"), value: t("orgChange.subject") },
                  { key: "drafted", label: t("approvals.field.requestedAt"), value: "2026-11-06" },
                  { key: "date", label: t("orgChange.date"), value: "2026-11-17" },
                  { key: "due", label: t("approvals.field.dueAt"), value: "11-12 · D-2" },
                ]}
              />
            </div>
          </div>
          <div className={fx.railSection}>
            <PaneHead title={t("approvals.preview.route")} />
            <div className={fx.railBody}>
              <ChainStepper
                steps={[
                  {
                    key: "s1",
                    who: `${t("enum.approvalRole.hr")} · ${tg("facts.repValue")}`,
                    state: "done",
                    meta: `${t("home.inbox.tab.done")} 11-06`,
                  },
                  {
                    key: "s2",
                    who: `${t("enum.approvalRole.finance")} · ${tg("search.person")}`,
                    state: "current",
                    meta: `→ ${t("orgChange.chain.current")}`,
                  },
                  {
                    key: "s3",
                    who: `${t("enum.approvalRole.executive")} · ${tg("links.person")}`,
                    state: "waiting",
                    meta: t("orgChange.settle.waiting"),
                  },
                ]}
              />
            </div>
          </div>
        </>
      }
      document={
        <>
          <div>
            <div className={fx.docKicker}>{t("orgChange.subject")}</div>
            <h2 className={fx.docTitle}>{t("orgChange.title.merge", { name: tg("sample.team"), into: tg("sample.dept") })}</h2>
            <div className={fx.docMeta}>{docMeta}</div>
          </div>
          <section className={fx.docSection}>
            <h3 className={fx.docSectionHead}>{sec1Title}</h3>
            <ChangeRows
              items={[
                {
                  id: "c1",
                  subject: tg("sample.dept"),
                  before: t("home.worklist.personCount", { count: 18 }),
                  after: t("home.worklist.personCount", { count: 30 }),
                },
                {
                  id: "c2",
                  subject: tg("sample.team"),
                  before: t("home.worklist.personCount", { count: 12 }),
                  after: t("enum.unitStatus.DISSOLVED"),
                },
                {
                  id: "c3",
                  subject: tg("links.person"),
                  before: tg("sample.team"),
                  after: `${tg("sample.dept")} · ${tg("sample.position")}`,
                },
              ]}
            />
          </section>
          <section className={fx.docSection}>
            <h3 className={fx.docSectionHead}>{sec2Title}</h3>
            <RecordRows
              label={t("empCard.spine.acts")}
              rowId={r => r.id}
              rows={[
                {
                  id: "a1",
                  target: `${tg("sample.team")} ${t("home.worklist.personCount", { count: 12 })}`,
                  before: tg("sample.team"),
                  after: tg("sample.dept"),
                  date: "11-17",
                },
                {
                  id: "a2",
                  target: tg("links.person"),
                  before: tg("sample.team"),
                  after: `${tg("sample.dept")} · ${tg("sample.position")}`,
                  date: "11-17",
                },
              ]}
              columns={[
                { header: t("requests.col.subject"), cell: r => r.target },
                { header: t("orgChange.proposal"), cell: r => `${r.before} → ${r.after}` },
                { header: t("orgChange.date"), cell: r => <bdi className="num">{r.date}</bdi>, end: true },
              ]}
            />
          </section>
          <section className={fx.docSection}>
            <h3 className={fx.docSectionHead}>{sec3Title}</h3>
            <div className={fx.docBodyText}>{tg("composer.policyReason")}</div>
          </section>
          <section className={fx.docSection}>
            <h3 className={fx.docSectionHead}>{sec4Title}</h3>
            <KeyValue
              items={[
                {
                  key: "transfer",
                  label: t("home.worklist.impact.transfer"),
                  value: t("home.worklist.personCount", { count: 12 }),
                },
                {
                  key: "dependents",
                  label: t("home.worklist.impact.dependents"),
                  value: t("home.worklist.impact.dependentCount", { count: 1 }),
                },
              ]}
            />
          </section>
        </>
      }
      decisionLabel={t("approvals.viewer.decision")}
      decision={
        <>
          <PaneHead
            title={t("approvals.viewer.decision")}
            meta={t("orgChange.decide.step", { role: t("enum.approvalRole.finance"), n: 2, total: 3 })}
          />
          <div className={fx.decisionPad} data-outcome={outcome}>
            <div className={fx.turnBanner}>
              <Chip tone="info">{t("orgChange.turn", { role: t("enum.approvalRole.finance") })}</Chip>
              <bdi className="num">{dueMeta}</bdi>
            </div>
            <DecisionPane
              multiline
              opinion={opinion}
              onOpinionChange={setOpinion}
              onApprove={() => setOutcome("approved")}
              onReject={() => setOutcome("rejected")}
              onReturn={() => setOutcome("returned")}
              consequence={t("approvals.consequence.next_step")}
            />
          </div>
          <PaneHead title={t("approvals.field.verification")} level={3} />
          <div className={fx.linkList}>
            <a className={fx.linkItem} href="/people">
              <bdi>{linkTransfer}</bdi>
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <a className={fx.linkItem} href="/org">
              <bdi>{linkTeam}</bdi>
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <a className={fx.linkItem} href="/org">
              <bdi>{tg("sample.dept")}</bdi>
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
        </>
      }
      overlays={
        <Sheet
          open={historyOpen}
          title={t("orgChange.list.title")}
          onClose={() => setHistoryOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setHistoryOpen(false)}>{t("common.cancel")}</Button>}
        >
          {t("orgChange.title.merge", { name: tg("sample.team"), into: tg("sample.dept") })}
        </Sheet>
      }
    />
  );
}
