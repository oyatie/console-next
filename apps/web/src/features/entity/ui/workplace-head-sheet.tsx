// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { get } from "../../../lib/query";
import { useCommand } from "../../../lib/react/command";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { STRUCTURE_READS } from "../../../reference/org/api";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { personOption } from "../../../reference/person/ui/person-option";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { ENTITY_READS, setWorkplaceHead } from "../api";
import { workplaceName } from "../domain/view";
import { EntityError } from "./entity-error";
import css from "../../../reference/org/ui/structure.module.css";

const LIVE: ("ACTIVE" | "ON_LEAVE")[] = ["ACTIVE", "ON_LEAVE"];

/** Appoint or clear a workplace's head (`PUT /api/v1/workplaces/{workplaceId}/head`). */
export function WorkplaceHeadSheet({ w, onClose }: { w: Workplace; onClose: () => void }) {
  const [opened] = useState(w);
  const [head, setHead] = useState<string | null>(opened.head?.employee_id ?? null);
  const [query, setQuery] = useState("");
  const box = useFocusInside<HTMLDivElement>();
  const name = workplaceName(opened);
  const q = query.trim();
  const people = useQuery(
    get("/api/v1/employees", {
      params: {
        query: q
          ? { search: q, status: LIVE, limit: 20 }
          : { workplace_id: opened.id, status: LIVE, limit: 20 },
      },
    }),
  );
  const peers = people.data?.items ?? [];
  const selected = peers.find((p) => p.id === head);
  const options = peers.map((e) => ({
    ...personOption(e, peers),
    context: e.org_unit ?? undefined,
  }));
  if (opened.head && !options.some((o) => o.id === opened.head!.employee_id)) {
    options.unshift({
      ...personOption({ id: opened.head.employee_id, name: opened.head.name }, peers),
      context: t("orgUnit.head.current"),
    });
  }
  const same = head === (opened.head?.employee_id ?? null);
  const save = useCommand({
    run: (_: undefined, key: string) => setWorkplaceHead(key, opened.id, head),
    invalidates: [...ENTITY_READS, ...STRUCTURE_READS],
    awaitFirstRead: true,
    announce: () =>
      head
        ? t("workplace.head.done", { name })
        : t("workplace.head.cleared", { name }),
    onSuccess: onClose,
  });

  return (
    <Composer
      kicker={name}
      title={t("workplace.head.appoint")}
      layout="drawer"
      headingLevel={2}
      action={{ kind: "orgHead", mode: "assign" }}
      error={save.error}
      notice={<EntityError error={save.error} />}
      pending={save.isPending}
      onClose={onClose}
      blocked={same ? { reason: t("orgChange.edit.nothing") } : undefined}
      consequence={
        head ? t("workplace.head.effective", { date: fmtDate(todayKst()) }) : undefined
      }
      onSubmit={() => {
        if (!same) save.mutate(undefined);
      }}
    >
      <div ref={box} className={css.stack}>
        <ServerPicker
          label={t("workplace.head.field")}
          query={query}
          onQueryChange={setQuery}
          options={options}
          value={head}
          onChange={setHead}
          group={t(q ? "orgUnit.head.found" : "orgUnit.head.members")}
          loading={people.isPending}
          empty={t("orgUnit.head.none")}
        />
        {head && (
          <PersonLabel
            person={{
              ...selected,
              id: head,
              employee_id: head,
              name:
                selected?.name ??
                (opened.head?.employee_id === head ? opened.head.name : undefined),
            }}
            peers={peers}
          />
        )}
        {head && (
          <Button variant="ghost" size="sm" onClick={() => setHead(null)}>
            {t("orgUnit.head.clear")}
          </Button>
        )}
      </div>
    </Composer>
  );
}
