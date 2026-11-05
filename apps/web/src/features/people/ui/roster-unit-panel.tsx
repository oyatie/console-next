// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { unitMembersQuery } from "../../../reference/org/api";
import { rollupHeadcount } from "../../../reference/org/present";
import { Avatar } from "../../../ui/avatar/avatar";
import s from "./roster.module.css";

type Unit = components["schemas"]["OrgUnitHead"];

/** Related-record column (`?sel2=`) beside the person peek: department headcount, direct members, and filtered roster link. */
export function RosterUnitPanel({ unitId, units }: { unitId: string; units: Unit[] }) {
  const members = useQuery(unitMembersQuery(unitId));
  const total = rollupHeadcount(units).get(unitId) ?? 0;
  return (
    <QueryState q={members}>
      {(data) => {
        const items = data.items.slice(0, 8);
        return (<>
          <dl className={s.peekItems}><div><dt className={s.peekTerm}>{t("roster.columns.unit")}</dt><dd className="num">{t("orgStructure.peopleCount", { count: total })}</dd></div></dl>
          {items.length === 0 ? <div className={s.peekSub}>{t("orgStructure.members.none")}</div> : (
            <ul className={s.ways}>{items.map((m) => (
              <li key={m.employeeId} className="row">
                <Avatar name={m.name} />
                <div className="grow">
                  <Link to="/people/$id" params={{ id: m.employeeId }}>{m.name}</Link>
                  <div className={s.peekSub}>{[m.title, m.position].filter(Boolean).join(" · ")}{m.since && <>{m.title || m.position ? " · " : ""}<time dateTime={m.since}>{t("orgUnit.head.since", { date: fmtDate(m.since) })}</time></>}</div>
                </div>
                <div className={s.peekSub}>{m.employeeNumber ?? ""}</div>
              </li>
            ))}</ul>
          )}
          {total > 0 && <Link to="/people" search={{ unit: unitId }} className="row">{t("orgStructure.members.all", { count: total })}<ChevronRight size={14} aria-hidden /></Link>}
        </>);
      }}
    </QueryState>
  );
}
