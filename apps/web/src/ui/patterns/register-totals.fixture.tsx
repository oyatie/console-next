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

type PayRow = {
  id: string;
  nameKey?: "search.person" | "links.person" | "facts.repValue";
  n?: number;
  base: string;
  net: string;
  missingBank: boolean;
};

const PAY_ROWS: readonly PayRow[] = [
  { id: "10587", nameKey: "search.person", base: "3,100,000", net: "3,141,755", missingBank: false },
  { id: "10537", nameKey: "facts.repValue", base: "2,700,000", net: "2,592,892", missingBank: false },
  { id: "10062", n: 3, base: "4,300,000", net: "3,956,915", missingBank: false },
  { id: "10025", n: 4, base: "3,100,000", net: "2,986,235", missingBank: false },
  { id: "10416", nameKey: "links.person", base: "2,700,000", net: "2,559,000", missingBank: true },
  { id: "10178", n: 6, base: "3,100,000", net: "3,025,111", missingBank: false },
  { id: "10606", n: 7, base: "3,600,000", net: "3,345,334", missingBank: false },
  { id: "10263", n: 8, base: "3,600,000", net: "3,413,037", missingBank: false },
];

const READY: ReadState = { isPending: false, error: null, data: PAY_ROWS, refetch() {} };

/** Synthetic no-network showcase for RegisterTotals (`P6`). */
export default function RegisterTotalsExample({ q = READY }: { q?: ReadState }) {
  const [period, setPeriod] = useState("2026-10");
  const [filter, setFilter] = useState<"all" | "missing">("all");
  const [selected, setSelected] = useState<string>("10587");
  const [submitOpen, setSubmitOpen] = useState(false);

  const rowName = (r: PayRow) => (r.nameKey ? tg(r.nameKey) : tg("sample.person", { n: r.n ?? 1 }));
  const visible = PAY_ROWS.filter(r => (filter === "missing" ? r.missingBank : true));
  const active = PAY_ROWS.find(r => r.id === selected) ?? PAY_ROWS[0]!;
  const blockerText = `${t("payroll.stage.exceptions")} · ${t("attendance.count", { count: 1 })}`;
  const subtotalText = `${t("payroll.employee.net")} 23,517,755`;

  return (
    <RegisterTotals
      q={q}
      head={{
        title: t("payroll.title"),
        titleId: "register-totals-title",
        filters: (
          <>
            <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={period} onChange={setPeriod} />
            <Segmented
              label={t("payroll.title")}
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: t("home.inbox.filter.all"), count: PAY_ROWS.length },
                { id: "missing", label: t("payroll.stage.exceptions"), count: 1, tone: "danger" },
              ]}
            />
          </>
        ),
        primary: { id: "submit", label: t("payroll.run.requestApproval"), onAction: () => setSubmitOpen(true) },
      }}
      totals={
        <div className={fx.totalsGrid}>
          <div className={fx.stageCell}>
            <div className={fx.stageLabel}>{t("payroll.stages.title")}</div>
            <StepLine
              label={t("payroll.stages.title")}
              steps={[
                { key: "calc", label: t("payroll.run.CALCULATED"), state: "done" },
                { key: "approve", label: t("payroll.stage.approval"), state: "current" },
                { key: "pay", label: t("payroll.stage.payment"), state: "waiting" },
              ]}
            />
          </div>
          <StatRow
            label={t("payroll.title")}
            items={[
              { key: "cnt", label: t("attendanceRecords.board.person"), value: "757" },
              { key: "gross", label: t("payroll.employee.gross"), value: "2,514,380,000" },
              { key: "ded", label: t("payroll.employee.deductions"), value: "412,906,300" },
              { key: "net", label: t("payroll.employee.net"), value: "2,101,473,700" },
            ]}
          />
        </div>
      }
      blockers={
        <>
          <bdi>{blockerText}</bdi>
          <Chip tone="warn">{t("payroll.run.READY_FOR_REVIEW")}</Chip>
        </>
      }
      register={
        <Table
          label={t("payroll.title")}
          mobileLayout="compact"
          rows={[...visible]}
          rowId={r => r.id}
          selected={selected}
          onSelect={setSelected}
          columns={[
            { header: t("attendanceRecords.grid.name"), cell: r => rowName(r) },
            { header: t("empCard.f.unit"), wide: true, cell: () => tg("sample.team") },
            { header: t("payroll.employee.wage"), type: "money", wide: true, cell: r => r.base },
            { header: t("payroll.employee.net"), type: "money", cell: r => r.net },
            {
              header: t("payroll.channel"),
              fit: true,
              card: "status",
              cell: r => (
                <Chip tone={r.missingBank ? "danger" : "ok"}>
                  {r.missingBank ? t("payroll.stage.exceptions") : t("enum.checklistState.DONE")}
                </Chip>
              ),
            },
          ]}
        />
      }
      foot={
        <div className={fx.footBar}>
          <bdi>{t("roster.foot.range", { shown: visible.length, total: PAY_ROWS.length })}</bdi>
          <bdi className="num">{subtotalText}</bdi>
        </div>
      }
      preview={
        <>
          <PaneHead title={tg("paper.preview")} meta={`${rowName(active)} · ${active.id}`} />
          <div className={fx.previewCols}>
            <div className={fx.previewCol}>
              <Ledger
                title={t("payroll.employee.earnings")}
                unit={t("profile.won")}
                rows={[{ key: "base", label: t("payroll.employee.wage"), amount: active.base }]}
                totals={[{ key: "tot", label: t("payroll.employee.gross"), amount: active.base, kind: "total" }]}
              />
            </div>
            <div className={fx.previewCol}>
              <Ledger
                title={t("payroll.employee.deductions")}
                unit={t("profile.won")}
                rows={[{ key: "pen", label: t("enum.insurer.NPS"), amount: "151,515" }]}
                totals={[{ key: "tot", label: t("payroll.employee.insuranceTotal"), amount: "425,245", kind: "total" }]}
              />
            </div>
            <div className={fx.previewCol}>
              <div className={fx.netBox}>
                <div className={fx.stageLabel}>{t("payroll.employee.net")}</div>
                <div className={fx.heroFigure}>{active.net}</div>
              </div>
            </div>
          </div>
        </>
      }
      overlays={
        <Sheet
          open={submitOpen}
          title={t("payroll.run.requestApproval")}
          onClose={() => setSubmitOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSubmitOpen(false)}>{t("common.cancel")}</Button>}
        >
          {t("payroll.alpha")}
        </Sheet>
      }
    />
  );
}
