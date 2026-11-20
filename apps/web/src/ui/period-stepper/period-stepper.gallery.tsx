// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { todayKst } from "../../lib/pure/today";
import { PeriodStepper } from "./index";

export const order = 84;

/** Period navigation across day, week, month, and year units in plain and boxed variants. */
export default function PeriodStepperGallery() {
  const today = todayKst();
  const [day, setDay] = useState(today);
  const [week, setWeek] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [boxedMonth, setBoxedMonth] = useState("2026-10");
  const [compactMonth, setCompactMonth] = useState("2026-10");

  return (
    <section className="card gallery__section" data-period-stepper-gallery="">
      <h2 className="toolbar__title">{t("attendance.period.label")}</h2>
      <PeriodStepper unit="day" value={day} onChange={setDay} />
      <PeriodStepper unit="week" value={week} onChange={setWeek} />
      <PeriodStepper unit="month" value={month} onChange={setMonth} />
      <PeriodStepper unit="year" value={year} onChange={setYear} />
      <PeriodStepper
        unit="month"
        value={boxedMonth}
        onChange={setBoxedMonth}
        variant="boxed"
        showCurrent={false}
        label={tg("periodStepper.boxed")}
      />
      <PeriodStepper
        unit="month"
        value={compactMonth}
        onChange={setCompactMonth}
        variant="plain"
        showCurrent={false}
        label={tg("periodStepper.compact")}
      />
    </section>
  );
}
