import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { i18n, t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ItemList } from "../../../ui/item-list/item-list";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { personOption } from "../../../reference/person/ui/person-option";
import { personLabel, type PersonIdentity } from "../../../reference/person/present";
import { Sheet } from "../../../ui/sheet/sheet";
import { peopleQuery, placeCrewMembers, type Crew } from "../api";
import { dateText, refusalText } from "../present";

/**
 * Add people to a crew from a date. A person already in another crew moves: the server ends that membership the
 * day before (one person, one crew a day), and both stay in the roster's history.
 */
function CrewMembersSheetOpen({ crew, onClose, onPlaced }: { crew: Crew | null; onClose: () => void; onPlaced: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<PersonIdentity[]>([]);
  const [from, setFrom] = useState("");
  const found = useQuery({ ...peopleQuery(query.trim()), enabled: query.trim().length > 0, placeholderData: keepPreviousData });
  const people = found.data?.items ?? [];
  const options = people.map((e) => personOption(e, people));
  const run = useCommand({
    run: (_: void, key: string) => placeCrewMembers(crew!.id, { employee_ids: chosen.map((p) => p.id), valid_from: from }, key),
    invalidates: ["/api/v1/attendance"],
    onSuccess: () => onPlaced(t("attendanceCrews.crews.placed", { count: chosen.length, name: crew?.name ?? "", date: dateText(from) })),
  });
  const missing = [!chosen.length && t("attendanceCrews.crews.people"), !from && t("attendanceCrews.crews.from")].filter((x): x is string => !!x);
  const label = chosen.length && from ? t("attendanceCrews.crews.placeCommit", { count: chosen.length, date: dateText(from) }) : t("attendanceCrews.crews.addPeople");
  return (
    <Sheet
      open={!!crew}
      kicker={crew?.name}
      title={t("attendanceCrews.crews.addPeople")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={t("attendanceCrews.crews.placeConsequence")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {missing.length ? (
            <DisabledReason reason={t("attendanceSchedule.assign.missing", { fields: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(missing) })} control={(p) => <Button {...p} variant="primary">{label}</Button>} />
          ) : (
            <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>{label}</Button>
          )}
        </>
      }
    >
      <div className="form">
        <ServerPicker
          label={t("attendanceCrews.crews.people")}
          group={t("attendanceCrews.crews.peopleGroup")}
          query={query}
          onQueryChange={setQuery}
          options={options}
          value={null}
          loading={found.isFetching}
          empty={t("attendanceCrews.crews.peopleNone")}
          onChange={(id) => {
            const o = people.find((x) => x.id === id);
            if (o && !chosen.some((c) => c.id === o.id)) setChosen([...chosen, o]);
            setQuery("");
          }}
        />
        {chosen.length > 0 && (
          <ItemList
            label={t("attendanceCrews.crews.chosen")}
            items={chosen.map((p) => ({ key: p.id, text: <PersonLabel person={{ ...p, employee_id: p.id }} peers={chosen} />, end: <Button size="sm" variant="ghost" onClick={() => setChosen(chosen.filter((c) => c.id !== p.id))} aria-label={t("attendanceCrews.crews.unchooseOne", { name: personLabel(p, chosen).text })}>{t("attendanceCrews.crews.unchoose")}</Button> }))}
          />
        )}
        <DateField label={t("attendanceCrews.crews.from")} required value={from} onChange={setFrom} today={todayKst()} />
      </div>
    </Sheet>
  );
}

export function CrewMembersSheet(p: { crew: Crew | null; onClose: () => void; onPlaced: (message: string) => void }) {
  return p.crew ? <CrewMembersSheetOpen {...p} /> : null;
}
