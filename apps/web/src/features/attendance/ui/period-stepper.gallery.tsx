// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { Card } from "../../../ui/card/card";
import { PeriodStepper } from "./period-stepper";

export default function PeriodStepperGallery() {
  const today = todayKst();
  const [day, setDay] = useState(today), [week, setWeek] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7)), [year, setYear] = useState(today.slice(0, 4));
  return <Card title={t("attendance.period.label")}>
    <PeriodStepper unit="day" value={day} onChange={setDay} />
    <PeriodStepper unit="week" value={week} onChange={setWeek} />
    <PeriodStepper unit="month" value={month} onChange={setMonth} />
    <PeriodStepper unit="year" value={year} onChange={setYear} />
  </Card>;
}
