// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Form } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { Card } from "../../../ui/card/card";
import { DateField } from "../../../ui/date/date-field";
import { Field } from "../../../ui/field/field";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { Meter } from "../../../ui/meter/meter";
import { MeterBand, MeterLegend, type MeterLegendItem } from "../../../ui/meter/meter-legend";
import { Page } from "../../../ui/page/page";
import type { LeaveOptionKind, LeaveSpanMode } from "../domain/leave-form";
import s from "./leave-request-page.module.css";

/** Classic (`baseline`) fallback renderer for `/leave`, preserving baseline layout until Phase 7. */
export function LeaveRequestBaseline({
  q,
  statItems,
  meter,
  legendItems,
  notes,
  kind,
  onKindChange,
  kindItems,
  spanMode,
  onSpanModeChange,
  spanItems,
  startDate,
  endDate,
  onStartChange,
  onEndChange,
  onStartInvalid,
  onEndInvalid,
  startError,
  endError,
  today,
  consequenceItems,
  notice,
  actions,
  history,
  onSubmit,
}: {
  q: ReadState;
  statItems: readonly StatRowItem[];
  meter: { value: number; pending: number; max: number; warn: boolean; valueText: string };
  legendItems: readonly MeterLegendItem[];
  notes?: ReactNode;
  kind: LeaveOptionKind;
  onKindChange: (next: LeaveOptionKind) => void;
  kindItems: readonly { id: LeaveOptionKind; label: string }[];
  spanMode: LeaveSpanMode;
  onSpanModeChange: (next: LeaveSpanMode) => void;
  spanItems: readonly { id: LeaveSpanMode; label: string }[];
  startDate: string;
  endDate: string;
  onStartChange: (next: string) => void;
  onEndChange: (next: string) => void;
  onStartInvalid: (invalid: boolean) => void;
  onEndInvalid: (invalid: boolean) => void;
  startError?: string;
  endError?: string;
  today: string;
  consequenceItems: readonly StatRowItem[];
  notice?: ReactNode;
  actions: ReactNode;
  history?: ReactNode;
  onSubmit: () => void;
}) {
  return (
    <Page floorplan="P-04" q={q} head={{ title: t("leave.title"), titleId: "leave-request-title" }} layout="form">
      {() => (
        <div className={s.baselineWrap}>
          {notes}
          <Card title={t("leave.balance.label")}>
            <StatRow items={statItems} label={t("leave.balance.label")} />
            <MeterBand>
              <Meter
                value={meter.value}
                pending={meter.pending}
                max={meter.max}
                cells={30}
                warn={meter.warn}
                label={t("leave.meter.label")}
                valueText={meter.valueText}
              />
              <MeterLegend items={legendItems} />
            </MeterBand>
          </Card>
          <Card title={t("leave.title")}>
            <Form noValidate onSubmit={onSubmit} className={s.baselineWrap}>
              <Field label={t("leave.type.label")} required={null}>
                {() => (
                  <Segmented block label={t("leave.type.label")} value={kind} onChange={onKindChange} items={kindItems} />
                )}
              </Field>
              <div className={s.dateHead}>
                <span className="t-sm t-medium t-ink">{t("leave.date.label")}</span>
                <Segmented label={t("leave.date.modeLabel")} value={spanMode} onChange={onSpanModeChange} items={spanItems} />
              </div>
              <div className={s.datePair}>
                <DateField
                  label={t("leave.date.start")}
                  required={null}
                  value={startDate}
                  onChange={onStartChange}
                  onInvalid={onStartInvalid}
                  today={today}
                  error={startError}
                />
                <DateField
                  label={t("leave.date.end")}
                  required={null}
                  value={endDate}
                  onChange={onEndChange}
                  onInvalid={onEndInvalid}
                  today={today}
                  min={startDate}
                  disabled={kind !== "annual"}
                  error={endError}
                />
              </div>
              <ActionBar
                sticky={false}
                notice={notice}
                consequence={<StatRow items={consequenceItems} label={t("leave.summary.label")} />}
                actions={actions}
              />
            </Form>
          </Card>
          {history}
        </div>
      )}
    </Page>
  );
}
