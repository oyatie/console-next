// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { useActiveExperienceId } from "../../experience/dom";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Segmented } from "../button/segmented";
import { DateField } from "../date/date-field";
import { Field } from "../field/field";
import { TextArea } from "../field/text-area";
import { KeyValue, StatRow } from "../key-value/key-value";
import { Meter } from "../meter/meter";
import { FormPattern } from "./form";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { balance: 9.5 }, refetch() {} };

/** Synthetic no-network showcase for Form (`P7`). */
export default function FormExample({ q = READY }: { q?: ReadState }) {
  const experience = useActiveExperienceId();
  const [kind, setKind] = useState<"annual" | "am" | "pm">("annual");
  const [span, setSpan] = useState<"one" | "multi">("one");
  const [start, setStart] = useState("2026-11-21");
  const [end, setEnd] = useState("2026-11-21");
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(0);

  const requested = kind === "annual" ? 1 : 0.5;
  const remainingAfter = 9.5 - requested;
  const usedLegend = `${t("enum.importTarget.leave_used")} 5.5`;
  const afterLegend = `${t("enum.importTarget.leave_remaining")} ${remainingAfter}`;

  return (
    <FormPattern
      q={q}
      head={{ title: t("requests.title"), titleId: "form-pattern-title" }}
      summary={
        <>
          <StatRow
            label={t("requests.title")}
            items={[
              { key: "accrued", label: t("enum.importTarget.leave_accrued"), value: "15" },
              { key: "used", label: t("enum.importTarget.leave_used"), value: "5.5" },
              { key: "remain", label: t("enum.importTarget.leave_remaining"), value: "9.5" },
            ]}
          />
          <div className={fx.meterBand}>
            <Meter
              value={5.5}
              pending={requested}
              max={15}
              cells={30}
              label={t("enum.importTarget.leave_remaining")}
              valueText={tg("meter.leaveValueText")}
            />
            <div className={fx.meterLegend}>
              <bdi>{usedLegend}</bdi>
              <bdi>{afterLegend}</bdi>
            </div>
          </div>
        </>
      }
      sections={
        <>
          <div className={fx.formSection}>
            <Field label={t("attendance.col.kind")} required>
              {() => (
                <Segmented
                  label={t("attendance.col.kind")}
                  value={kind}
                  onChange={setKind}
                  items={[
                    { id: "annual", label: t("people.field.leave") },
                    { id: "am", label: tg("pat.form.halfAm") },
                    { id: "pm", label: tg("pat.form.halfPm") },
                  ]}
                />
              )}
            </Field>
          </div>
          <div className={fx.formSection}>
            <div className={fx.dateHead}>
              <strong>{t("attendance.col.date")}</strong>
              <Segmented
                label={t("attendance.col.date")}
                value={span}
                onChange={setSpan}
                items={[
                  { id: "one", label: t("attendanceRecords.day.tab.day") },
                  { id: "multi", label: t("attendance.tab.week") },
                ]}
              />
            </div>
            <div className={fx.datePair} data-baseline-stack={experience === "baseline" || undefined}>
              <DateField label={tg("form.date")} required value={start} onChange={setStart} today="2026-11-10" />
              <DateField label={t("accessLog.to")} required value={end} onChange={setEnd} today="2026-11-10" />
            </div>
          </div>
          <div className={fx.formSection}>
            <KeyValue
              label={t("empCard.f.unit")}
              items={[
                { key: "team", label: t("empCard.f.unit"), value: tg("sample.team") },
                { key: "chain", label: t("approvals.preview.route"), value: tg("facts.repValue") },
              ]}
            />
          </div>
          <div className={fx.formSection}>
            <Field label={t("orgChange.reason")} required={false}>
              {p => <TextArea {...p} rows={2} value={note} onChange={e => setNote(e.target.value)} />}
            </Field>
          </div>
        </>
      }
      consequence={
        <StatRow
          label={t("enum.importTarget.leave_remaining")}
          items={[
            { key: "cur", label: t("enum.importTarget.leave_remaining"), value: "9.5" },
            { key: "req", label: `− ${t("requests.col.kind")}`, value: `${requested}` },
            { key: "after", label: `= ${t("enum.importTarget.leave_remaining")}`, value: `${remainingAfter}`, tone: "primary" },
          ]}
        />
      }
      actions={
        <Button type="submit" variant="primary" size="lg" data-submitted={submitted}>
          {t("home.inbox.activity.verb.submit")}
        </Button>
      }
      onSubmit={() => setSubmitted(n => n + 1)}
    />
  );
}
