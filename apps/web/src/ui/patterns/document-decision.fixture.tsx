// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
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
import { Sheet } from "../sheet/sheet";
import { DocumentDecision } from "./document-decision";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { id: "OC-2026-0418" }, refetch() {} };

/** Synthetic no-network showcase for DocumentDecision (`P4`). */
export default function DocumentDecisionExample({ q = READY }: { q?: ReadState }) {
  const [opinion, setOpinion] = useState("");
  const [outcome, setOutcome] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <DocumentDecision
      q={q}
      head={{
        title: tg("pat.doc.head"),
        titleId: "doc-decision-title",
        filters: <Chip>{tg("pat.doc.queue")}</Chip>,
        meta: <bdi>{tg("pat.doc.ref")}</bdi>,
        actions: (
          <Button size="sm" variant="secondary" onClick={() => setHistoryOpen(true)}>
            {tg("pat.record.secHistory")}
          </Button>
        ),
      }}
      start={
        <>
          <div className={fx.railSection}>
            <PaneHead title={tg("pat.doc.facts")} />
            <div className={fx.railBody}>
              <KeyValue
                density="dense"
                items={[
                  { key: "ref", label: tg("pat.doc.facts"), value: "OC-2026-0418" },
                  { key: "date", label: tg("facts.open"), value: "2026-11-17" },
                ]}
              />
            </div>
          </div>
          <div className={fx.railSection}>
            <PaneHead title={tg("pat.doc.chain")} />
            <div className={fx.railBody}>
              <ChainStepper
                steps={[
                  { key: "s1", who: tg("facts.repValue"), state: "done", meta: "11-06" },
                  { key: "s2", who: tg("search.person"), state: "current", meta: tg("pat.doc.decision") },
                ]}
              />
            </div>
          </div>
        </>
      }
      document={
        <>
          <div>
            <div className={fx.docKicker}>{tg("pat.doc.ref")}</div>
            <h2 className={fx.docTitle}>{tg("pat.doc.title")}</h2>
            <div className={fx.docMeta}>{tg("pat.doc.meta")}</div>
          </div>
          <section className={fx.docSection}>
            <h3 className={fx.docSectionHead}>{tg("pat.doc.changes")}</h3>
            <ChangeRows
              items={[
                { id: "c1", subject: tg("sample.dept"), before: tg("sample.team"), after: tg("sample.position") },
              ]}
            />
          </section>
          <section className={fx.docSection}>
            <h3 className={fx.docSectionHead}>{tg("pat.doc.reason")}</h3>
            <div className={fx.docBodyText}>{tg("pat.doc.reasonBody")}</div>
          </section>
        </>
      }
      decisionLabel={tg("pat.doc.decision")}
      decision={
        <>
          <PaneHead title={tg("pat.doc.decision")} meta={tg("pat.doc.decisionMeta")} />
          <div className={fx.decisionPad} data-outcome={outcome}>
            <DecisionPane
              multiline
              opinion={opinion}
              onOpinionChange={setOpinion}
              onApprove={() => setOutcome("approved")}
              onReject={() => setOutcome("rejected")}
              onReturn={() => setOutcome("returned")}
              consequence={tg("pat.doc.consequence")}
            />
          </div>
          <PaneHead title={tg("pat.doc.links")} level={3} />
          <div className={fx.linkList}>
            <a className={fx.linkItem} href="/people">
              <bdi>{tg("pat.doc.linkLabel")}</bdi>
            </a>
          </div>
        </>
      }
      overlays={
        <Sheet
          open={historyOpen}
          title={tg("pat.record.secHistory")}
          onClose={() => setHistoryOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setHistoryOpen(false)}>{t("common.cancel")}</Button>}
        >
          {tg("pat.doc.title")}
        </Sheet>
      }
    />
  );
}
