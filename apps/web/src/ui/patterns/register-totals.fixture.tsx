// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Segmented } from "../button/segmented";
import { Chip } from "../chip";
import { StatRow } from "../key-value/key-value";
import { Ledger } from "../ledger/ledger";
import { PaneHead } from "../pane-grid/pane-grid";
import { PeriodStepper } from "../period-stepper/period-stepper";
import { Sheet } from "../sheet/sheet";
import { StepLine } from "../step-line/step-line";
import { Table } from "../table";
import { RegisterTotals } from "./register-totals";
import fx from "./pattern-fixture.module.css";

const PAY_ROWS = [
  { id: "10587", name: "Yoon Hajun", dept: "Production 1", base: "3,100,000", net: "3,141,755", missingBank: false },
  { id: "10416", name: "Lee Jeongu", dept: "Sales 1", base: "2,700,000", net: "2,559,000", missingBank: true },
] as const;

const READY: ReadState = { isPending: false, error: null, data: PAY_ROWS, refetch() {} };

/** Synthetic no-network showcase for RegisterTotals (`P6`). */
export default function RegisterTotalsExample({ q = READY }: { q?: ReadState }) {
  const [period, setPeriod] = useState("2026-10");
  const [filter, setFilter] = useState<"all" | "missing">("all");
  const [selected, setSelected] = useState<string>("10587");
  const [submitOpen, setSubmitOpen] = useState(false);

  const visible = PAY_ROWS.filter(r => (filter === "missing" ? r.missingBank : true));
  const active = PAY_ROWS.find(r => r.id === selected) ?? PAY_ROWS[0];

  return (
    <RegisterTotals
      q={q}
      head={{
        title: tg("pat.reg.head"),
        titleId: "register-totals-title",
        filters: (
          <>
            <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={period} onChange={setPeriod} />
            <Segmented
              label={tg("pat.reg.head")}
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: tg("pat.month.filterAll"), count: PAY_ROWS.length },
                { id: "missing", label: tg("pat.reg.bankHold"), count: 1, tone: "danger" },
              ]}
            />
          </>
        ),
        primary: { id: "submit", label: tg("pat.reg.stage"), onAction: () => setSubmitOpen(true) },
      }}
      totals={
        <div className={fx.totalsGrid}>
          <div className={fx.stageCell}>
            <div className={fx.stageLabel}>{tg("pat.reg.stage")}</div>
            <StepLine
              label={tg("pat.reg.stage")}
              steps={[
                { key: "calc", label: tg("pat.reg.stage"), state: "done" },
                { key: "approve", label: tg("pat.doc.head"), state: "current" },
              ]}
            />
          </div>
          <StatRow
            label={tg("pat.reg.head")}
            items={[
              { key: "cnt", label: tg("pat.reg.target"), value: "757" },
              { key: "gross", label: tg("pat.reg.gross"), value: "2,514,380,000" },
              { key: "ded", label: tg("pat.reg.deduct"), value: "412,906,300" },
              { key: "net", label: tg("pat.reg.net"), value: "2,101,473,700" },
            ]}
          />
        </div>
      }
      blockers={
        <>
          <bdi>{tg("pat.reg.blocker")}</bdi>
          <Chip tone="warn">{tg("pat.reg.advisory")}</Chip>
        </>
      }
      register={
        <Table
          label={tg("pat.reg.head")}
          mobileLayout="compact"
          rows={[...visible]}
          rowId={r => r.id}
          selected={selected}
          onSelect={setSelected}
          columns={[
            { header: tg("search.label"), cell: r => r.name },
            { header: tg("pat.hub.dept"), wide: true, cell: r => r.dept },
            { header: tg("pat.stmt.basePay"), type: "money", wide: true, cell: r => r.base },
            { header: tg("pat.stmt.netLabel"), type: "money", cell: r => r.net },
            {
              header: tg("pat.reg.bankOk"),
              fit: true,
              cell: r => (
                <Chip tone={r.missingBank ? "danger" : "ok"}>
                  {r.missingBank ? tg("pat.reg.bankHold") : tg("pat.reg.bankOk")}
                </Chip>
              ),
            },
          ]}
        />
      }
      foot={<div className={fx.bandPad}>{tg("pat.reg.subtotal")}</div>}
      preview={
        <>
          <PaneHead title={tg("pat.reg.preview")} meta={`${active.name} · ${active.id}`} />
          <div className={fx.previewCols}>
            <div className={fx.previewCol}>
              <Ledger
                title={tg("pat.stmt.earnings")}
                unit={tg("ledger.unit")}
                rows={[{ key: "base", label: tg("pat.stmt.basePay"), amount: active.base }]}
                totals={[{ key: "tot", label: tg("pat.reg.gross"), amount: active.base, kind: "total" }]}
              />
            </div>
            <div className={fx.previewCol}>
              <Ledger
                title={tg("pat.stmt.deductions")}
                unit={tg("ledger.unit")}
                rows={[{ key: "pen", label: tg("pat.stmt.pension"), amount: "151,515" }]}
                totals={[{ key: "tot", label: tg("ledger.deductionTotal"), amount: "425,245", kind: "total" }]}
              />
            </div>
            <div className={fx.previewCol}>
              <div className={fx.netBox}>
                <div className={fx.stageLabel}>{tg("pat.stmt.netLabel")}</div>
                <div className={fx.heroFigure}>{active.net}</div>
              </div>
            </div>
          </div>
        </>
      }
      overlays={
        <Sheet
          open={submitOpen}
          title={tg("pat.reg.stage")}
          onClose={() => setSubmitOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSubmitOpen(false)}>{t("common.cancel")}</Button>}
        >
          {tg("pat.reg.advisory")}
        </Sheet>
      }
    />
  );
}
