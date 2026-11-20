// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { useActiveExperienceId } from "../../experience/dom";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Segmented } from "../button/segmented";
import { ChoiceField } from "../choice/choice-field";
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
  const [kind, setKind] = useState("annual");
  const [span, setSpan] = useState<"one" | "multi">("one");
  const [start, setStart] = useState("2026-11-21");
  const [end, setEnd] = useState("2026-11-21");
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(0);

  const requested = kind === "annual" ? 1 : 0.5;
  const remainingAfter = 9.5 - requested;
  const usedLegend = `${tg("pat.form.used")} 5.5d`;
  const afterLegend = `${tg("pat.form.after")} ${remainingAfter}d`;

  return (
    <FormPattern
      q={q}
      head={{ title: tg("pat.form.head"), titleId: "form-pattern-title" }}
      summary={
        <>
          <StatRow
            label={tg("pat.form.head")}
            items={[
              { key: "accrued", label: tg("pat.form.accrued"), value: "15d" },
              { key: "used", label: tg("pat.form.used"), value: "5.5d" },
              { key: "remain", label: tg("pat.form.remain"), value: "9.5d" },
            ]}
          />
          <div className={fx.meterBand}>
            <Meter
              value={5.5}
              pending={requested}
              max={15}
              cells={30}
              label={tg("pat.form.remain")}
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
            <ChoiceField
              label={tg("pat.form.kind")}
              required
              value={kind}
              onChange={setKind}
              options={[
                { value: "annual", label: tg("pat.form.annual") },
                { value: "am", label: tg("pat.form.halfAm") },
                { value: "pm", label: tg("pat.form.halfPm") },
              ]}
            />
          </div>
          <div className={fx.formSection}>
            <div className={fx.dateHead}>
              <strong>{tg("pat.form.date")}</strong>
              <Segmented
                label={tg("pat.form.date")}
                value={span}
                onChange={setSpan}
                items={[
                  { id: "one", label: tg("pat.form.oneDay") },
                  { id: "multi", label: tg("pat.form.multiDay") },
                ]}
              />
            </div>
            <div className={fx.datePair} data-baseline-stack={experience === "baseline" || undefined}>
              <DateField label={tg("pat.form.start")} required value={start} onChange={setStart} today="2026-11-10" />
              <DateField label={tg("pat.form.end")} required value={end} onChange={setEnd} today="2026-11-10" />
            </div>
          </div>
          <div className={fx.formSection}>
            <KeyValue
              label={tg("pat.form.team")}
              items={[
                { key: "team", label: tg("pat.form.team"), value: tg("pat.form.teamVal") },
                { key: "chain", label: tg("pat.doc.chain"), value: tg("facts.repValue") },
              ]}
            />
          </div>
          <div className={fx.formSection}>
            <Field label={tg("pat.form.note")} required={false}>
              {p => <TextArea {...p} rows={3} value={note} onChange={e => setNote(e.target.value)} />}
            </Field>
          </div>
        </>
      }
      consequence={
        <StatRow
          label={tg("pat.form.after")}
          items={[
            { key: "cur", label: tg("pat.form.remain"), value: "9.5d" },
            { key: "req", label: tg("pat.form.kind"), value: `${requested}d` },
            { key: "after", label: tg("pat.form.after"), value: `${remainingAfter}d`, tone: "primary" },
          ]}
        />
      }
      actions={
        <Button type="submit" variant="primary" size="lg" data-submitted={submitted}>
          {tg("pat.form.submit")}
        </Button>
      }
      onSubmit={() => setSubmitted(n => n + 1)}
    />
  );
}
