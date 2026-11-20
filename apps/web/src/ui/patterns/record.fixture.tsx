// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Chip } from "../chip";
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

  return (
    <RecordPattern
      q={q}
      head={{
        title: tg("search.person"),
        titleId: "record-title",
        meta: (
          <>
            <Tag kind="rev">{tg("facts.active")}</Tag>
            <bdi>{tg("pat.record.role")}</bdi>
          </>
        ),
        primary: { id: "edit", label: t("uiRecord.edit"), onAction: () => setEditOpen(true) },
      }}
      secNav={
        <SecNav
          current={section}
          onJump={setSection}
          items={[
            { id: "sec-basic", no: 1, title: tg("pat.record.secBasic") },
            { id: "sec-personal", no: 2, title: tg("pat.record.secPersonal") },
            { id: "sec-history", no: 3, title: tg("pat.record.secHistory"), count: 2 },
          ]}
        />
      }
      sections={
        <>
          <RecordSection id="sec-basic" no={1} title={tg("pat.record.secBasic")}>
            <KeyValue
              items={[
                { key: "hire", label: tg("pat.record.hire"), value: "2019-03-14" },
                { key: "work", label: tg("pat.record.work"), value: tg("pat.record.workVal") },
              ]}
            />
          </RecordSection>
          <RecordSection id="sec-personal" no={2} title={tg("pat.record.secPersonal")}>
            <KeyValue
              items={[
                { key: "phone", label: tg("pat.record.phone"), value: <Masked>{tg("pat.record.phoneVal")}</Masked> },
                { key: "addr", label: tg("pat.record.addr"), value: tg("pat.record.addrVal") },
              ]}
            />
          </RecordSection>
          <RecordSection id="sec-history" no={3} title={tg("pat.record.secHistory")}>
            <RecordRows
              label={tg("pat.record.secHistory")}
              rowId={r => r.id}
              rows={[
                { id: "h1", date: "2024-01-01", note: tg("pat.record.nowVal") },
                { id: "h2", date: "2022-01-01", note: tg("pat.record.revNote") },
              ]}
              columns={[
                { header: tg("facts.open"), cell: r => <bdi className="num">{r.date}</bdi> },
                { header: tg("pat.record.secHistory"), cell: r => <Chip>{r.note}</Chip> },
              ]}
            />
          </RecordSection>
        </>
      }
      spine={
        <Spine
          title={tg("pat.record.history")}
          nowKey={tg("facts.active")}
          now={tg("pat.record.nowVal")}
          items={[
            { key: "s1", tone: "rev", when: "2024-01-01", what: tg("pat.record.nowVal") },
            { key: "s2", tone: "new", when: "2019-03-14", what: tg("pat.record.hire") },
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
