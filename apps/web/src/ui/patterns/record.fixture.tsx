// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { KeyValue } from "../key-value/key-value";
import { Masked } from "../record/masked";
import { RecordSection, Tag } from "../record/record-section";
import { RecordRows } from "../record/rows";
import { SecNav } from "../record/sec-nav";
import { Spine } from "../record/spine";
import { Sheet } from "../sheet/sheet";
import { RecordPattern } from "./record";

const READY: ReadState = { isPending: false, error: null, data: { id: "10587" }, refetch() {} };

/** Synthetic no-network showcase for Record (`P3`). */
export default function RecordExample({ q = READY }: { q?: ReadState }) {
  const [section, setSection] = useState("sec-basic");
  const [editOpen, setEditOpen] = useState(false);
  const roleMeta = `${t("empCard.empno", { no: "10587" })} · ${tg("sample.position")} · ${tg("sample.team")}`;

  return (
    <RecordPattern
      q={q}
      head={{
        title: tg("search.person"),
        titleId: "record-title",
        meta: (
          <>
            <Tag kind="rev">{tg("facts.active")}</Tag>
            <bdi>{roleMeta}</bdi>
          </>
        ),
        primary: { id: "edit", label: t("uiRecord.edit"), onAction: () => setEditOpen(true) },
      }}
      secNav={
        <SecNav
          current={section}
          onJump={setSection}
          items={[
            { id: "sec-basic", no: 1, title: t("empCard.sec.job") },
            { id: "sec-personal", no: 2, title: t("empCard.sec.personal") },
            { id: "sec-history", no: 3, title: t("empCard.tab.events"), count: 3 },
          ]}
        />
      }
      sections={
        <>
          <RecordSection id="sec-basic" no={1} title={t("empCard.sec.job")}>
            <KeyValue
              items={[
                { key: "hire", label: t("empCard.f.hire"), value: "2019-03-14" },
                { key: "work", label: t("empCard.f.workForm"), value: t("enum.employmentType.REGULAR") },
                { key: "unit", label: t("empCard.f.unit"), value: `${tg("sample.dept")} › ${tg("sample.team")}` },
              ]}
            />
          </RecordSection>
          <RecordSection id="sec-personal" no={2} title={t("empCard.sec.personal")}>
            <KeyValue
              items={[
                { key: "phone", label: t("empCard.f.phone"), value: <Masked>{tg("pat.record.phoneVal")}</Masked> },
                { key: "addr", label: t("empCard.f.address"), value: tg("addr.road") },
              ]}
            />
          </RecordSection>
          <RecordSection id="sec-history" no={3} title={t("empCard.tab.events")}>
            <RecordRows
              label={t("empCard.tab.events")}
              rowId={r => r.id}
              rows={[
                { id: "h1", date: "2024-01-01", note: t("empCard.next.appoint", { to: tg("sample.team") }) },
                { id: "h2", date: "2022-01-01", note: t("empCard.grade.since", { date: "2022-01-01" }) },
                { id: "h3", date: "2019-03-14", note: t("empCard.f.hire") },
              ]}
              columns={[
                { header: t("empCard.ledger.from"), cell: r => <bdi className="num">{r.date}</bdi> },
                { header: t("empCard.ledger.what"), cell: r => r.note },
              ]}
            />
          </RecordSection>
        </>
      }
      spine={
        <Spine
          title={t("empCard.spine.title")}
          nowKey={t("empCard.spine.now", { date: "2026-11-10" })}
          now={`${tg("facts.active")} · ${tg("sample.dept")} › ${tg("sample.team")} · ${tg("sample.position")}`}
          items={[
            { key: "s1", tone: "rev", when: "2024-01-01", what: t("empCard.next.appoint", { to: tg("sample.team") }) },
            { key: "s2", tone: "rev", when: "2022-01-01", what: t("empCard.grade.since", { date: "2022-01-01" }) },
            { key: "s3", tone: "new", when: "2019-03-14", what: t("empCard.f.hire") },
          ]}
        />
      }
      overlays={
        <Sheet
          open={editOpen}
          title={t("uiRecord.edit")}
          onClose={() => setEditOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setEditOpen(false)}>{t("common.cancel")}</Button>}
        >
          {tg("search.person")}
        </Sheet>
      }
    />
  );
}
