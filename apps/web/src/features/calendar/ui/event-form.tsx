// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { branchesQuery } from "../../../reference/org/api";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Form } from "../../../ui/button/button";
import { Button } from "../../../ui/button/button-base";
import { DateField } from "../../../ui/date/date-field";
import { addDays } from "../../../ui/date/days";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { TextArea } from "../../../ui/field/text-area";
import type { NewEvent } from "../api";
import s from "./calendar.module.css";

type Grant = { org_wide: boolean; branch_scope: { kind: "all" | "branches"; branches?: string[] } };
export function EventForm({ initial, grant, busy, save }: { initial: string; grant?: Grant; busy: boolean; save: (input: NewEvent) => void }) {
  const [name, setName] = useState(""), [description, describe] = useState("");
  const [scope, choose] = useState<NewEvent["scope_type"]>("PERSONAL"), [target, setTarget] = useState("");
  const [startDay, setStart] = useState(initial), [endDay, setEnd] = useState(initial);
  const [badStart, invalidStart] = useState(false), [badEnd, invalidEnd] = useState(false);
  const [startTime, setStartTime] = useState("09:00"), [endTime, setEndTime] = useState("10:00"), [allDay, whole] = useState(false);
  const branches = useQuery({ ...branchesQuery, enabled: scope === "DEPARTMENT" && !!grant });
  const permitted = (branches.data ?? []).filter(row => !row.deactivated_at && (grant?.branch_scope.kind === "all" || grant?.branch_scope.branches?.includes(row.id)));
  const starts = startDay && `${startDay}T${allDay ? "00:00" : startTime}:00+09:00`;
  const ends = endDay && `${allDay ? addDays(endDay, 1) : endDay}T${allDay ? "00:00" : endTime}:00+09:00`;
  const ordered = !!starts && !!ends && Date.parse(ends) > Date.parse(starts);
  const allowed = scope === "PERSONAL" || (scope === "DEPARTMENT" ? permitted.some(row => row.id === target) : !!grant?.org_wide && (scope !== "TEAM" || !!target.trim()));
  const ready = !!name.trim() && ordered && !badStart && !badEnd && allowed && !busy;
  return <Form className={s.form} onSubmit={() => {
    if (ready) save({ scope_type: scope, ...(scope === "TEAM" || scope === "DEPARTMENT" ? { scope_ref: target.trim() } : {}), title: name.trim(), description: description.trim(), starts_at: starts, ends_at: ends, all_day: allDay });
  }}>
    <Field label={t("internalCalendar.name")} required>{props => <TextInput {...props} maxLength={160} value={name} onChange={e => setName(e.target.value)} />}</Field>
    <Field label={t("internalCalendar.audience")} required>{props => <SelectInput {...props} value={scope} onChange={e => { choose(e.target.value as NewEvent["scope_type"]); setTarget(""); }}>
      <option value="PERSONAL">{t("internalCalendar.personal")}</option>
      {grant && <option value="DEPARTMENT">{t("internalCalendar.department")}</option>}
      {grant?.org_wide && <><option value="TENANT">{t("internalCalendar.organization")}</option><option value="TEAM">{t("internalCalendar.team")}</option></>}
    </SelectInput>}</Field>
    {scope === "DEPARTMENT" && <QueryState q={branches}>{() => <Field label={t("internalCalendar.department")} required>{props =>
      <SelectInput {...props} value={target} onChange={e => setTarget(e.target.value)}><option value="">{t("internalCalendar.select")}</option>{permitted.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</SelectInput>}</Field>}</QueryState>}
    {scope === "TEAM" && <Field label={t("internalCalendar.teamName")} required>{props => <TextInput {...props} maxLength={160} value={target} onChange={e => setTarget(e.target.value)} />}</Field>}
    <Field label={t("internalCalendar.allDay")} required={null}>{props => <TextInput {...props} type="checkbox" checked={allDay} onChange={e => whole(e.target.checked)} />}</Field>
    <DateField label={t("internalCalendar.startDay")} required today={todayKst()} value={startDay} onChange={setStart} onInvalid={invalidStart} />
    {!allDay && <Field label={t("internalCalendar.startTime")} required>{props => <TextInput {...props} type="time" value={startTime} onChange={e => setStartTime(e.target.value)} />}</Field>}
    <DateField label={t("internalCalendar.endDay")} required today={todayKst()} value={endDay} min={startDay || undefined} onChange={setEnd} onInvalid={invalidEnd} />
    {!allDay && <Field label={t("internalCalendar.endTime")} required error={ends && !ordered ? t("internalCalendar.invalidTime") : undefined}>{props => <TextInput {...props} type="time" value={endTime} onChange={e => setEndTime(e.target.value)} />}</Field>}
    <Field label={t("internalCalendar.description")} required={false}>{props => <TextArea {...props} rows={3} maxLength={2000} value={description} onChange={e => describe(e.target.value)} />}</Field>
    <Button type="submit" disabled={!ready}>{t("internalCalendar.save")}</Button>
  </Form>;
}
