import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { peopleQuery } from "../api";

/**
 * One person's calendar (the person layer: reduced or moved hours, covering a shift): people are not in the scope tree, so they are
 * found here by name or employee number. Choosing one opens their month with the full decision order.
 */
export function PersonScope({ onPerson }: { onPerson: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const found = useQuery({ ...peopleQuery(query.trim()), enabled: query.trim().length > 0, placeholderData: keepPreviousData });
  const options = (found.data?.items ?? []).map((e) => ({ id: e.id, name: e.name, code: e.employee_number ?? undefined }));
  return (
    <ServerPicker
      label={t("attendanceSchedule.person.find")}
      group={t("attendanceSchedule.person.group")}
      query={query}
      onQueryChange={setQuery}
      options={options}
      value={null}
      loading={found.isFetching}
      empty={t("attendanceSchedule.person.none")}
      onChange={(id) => {
        if (id) onPerson(id);
        setQuery("");
      }}
    />
  );
}
