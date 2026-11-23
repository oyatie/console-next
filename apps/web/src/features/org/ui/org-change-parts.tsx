// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { unitsQuery } from "../../../reference/org/api";
import { Banner } from "../../../ui/banner/banner";
import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Receipt } from "../../../ui/receipt/receipt";
import { StatusDock } from "../../../ui/status-dock/status-dock";
import { TimelineLanes } from "../../../ui/timeline-lanes/timeline-lanes";
import { describeOp, eventTitle, reasonText, type Names } from "../present";
import { ChangeNextStep } from "./change-next-step";
import { DraftEditor } from "./draft-editor";
import { UnitDiff } from "./unit-parts";
import type { useOrgChangeRecord } from "./use-org-change-record";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
const PREVIEWED = new Set<string>(["CREATE_ORG_UNIT", "RENAME_ORG_UNIT", "MOVE_ORG_UNIT", "DISSOLVE_ORG_UNIT", "REASSIGN_ORG_UNIT"]);

export function OrgChangeReceiptDock({ code, receipt }: { code: string; receipt: NonNullable<ReturnType<typeof useOrgChangeRecord>["note"]> }) {
  return (
    <StatusDock>
      <div id="change-receipt" tabIndex={-1} className={css.receipt}>
        <Receipt state="recorded" message={receipt.message} meta={<ReceiptReference value={code} />} actions={receipt.actions} />
      </div>
    </StatusDock>
  );
}

export function OrgChangeHistoryTimeline({ events }: { events: Detail["events"] }) {
  return (
    <TimelineLanes
      items={events.map((e, i) => ({ key: `${i}`, date: fmtDateTime(e.at), ...eventTitle(e) })).reverse()}
      empty={t("orgChange.history.empty")}
    />
  );
}

export function OrgChangeNotices({
  unsentCount,
  leftDraftAt,
}: {
  unsentCount: number;
  leftDraftAt?: string | null;
}) {
  return (
    <>
      {unsentCount > 0 && <Banner tone="danger">{t("orgChange.unsent", { count: unsentCount })}</Banner>}
      {leftDraftAt && <output>{t("orgChange.edit.submittedElsewhere", { time: fmtDateTime(leftDraftAt) })}</output>}
    </>
  );
}

export function OrgChangeNextStep({
  d,
  st,
  n,
  refetch,
  flat,
}: {
  d: Detail;
  st: ReturnType<typeof useOrgChangeRecord>;
  n: Names;
  refetch: () => Promise<{ data?: Detail }>;
  flat?: boolean;
}) {
  return (
    <ChangeNextStep
      d={d}
      s={st.s!}
      title={st.title}
      n={n}
      today={st.today}
      report={st.report}
      hold={Boolean(st.note?.hold)}
      editor={
        st.editing && (
          <DraftEditor
            d={d}
            refetch={refetch}
            onSaved={() => st.preflight.mutate(undefined)}
            onNote={st.show}
            onClose={() => st.setEditing(false)}
          />
        )
      }
      refetch={refetch}
      onNote={st.show}
      onReopen={st.clear}
      onEdit={() => st.setEditing(true)}
      onPreflight={() => st.preflight.mutate(undefined)}
      flat={flat}
    />
  );
}

export function ProposalBody({ d, n, headcount, flat }: { d: Detail; n: Names; headcount: number; flat?: boolean }) {
  return (
    <>
      <ol className={css.ops}>{d.proposal.map((op, i) => <li key={i}>{describeOp(op, n)}</li>)}</ol>
      <KeyValue
        readOnly
        items={[
          { key: "reason", label: t("orgChange.reason"), value: <blockquote className={css.quote}>{reasonText(d)}</blockquote> },
          {
            key: "headcount",
            label: t("orgChange.headcount"),
            value: <bdi className="num">{t(d.status === "APPLIED" ? "orgChange.headcount.moved" : "orgChange.headcount.value", { count: headcount })}</bdi>,
          },
        ]}
      />
      <Preview d={d} n={n} flat={flat} />
    </>
  );
}

function Preview({ d, n, flat }: { d: Detail; n: Names; flat?: boolean }) {
  const units = useQuery(unitsQuery);
  const pending = d.status === "DRAFT" || d.status === "PRECHECKED" || d.status === "IN_APPROVAL" || d.status === "APPROVED" || d.status === "REJECTED";
  const ops = d.proposal.filter((op) => PREVIEWED.has(op.op));
  if (!pending || !units.data || ops.length === 0) return null;
  const then = t("orgPropose.diff.then", { date: fmtDate(d.effectiveDate) });
  return (
    <>
      <h3 className={css.formHead}>{t("orgChange.preview")}</h3>
      {ops.map((op, i) => <UnitDiff key={i} units={units.data.items} op={op} summary={describeOp(op, n)} then={then} flat={flat} />)}
    </>
  );
}
