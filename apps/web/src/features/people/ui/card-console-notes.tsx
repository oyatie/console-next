// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Building2, CalendarDays, MapPin, UserPlus } from "lucide-react";
import { focusSoon } from "../../../lib/react/announce";
import { EmployeePayLink } from "../../../reference/payroll/ui/employee-pay-link";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { retirementDate } from "../domain/employment";
import type { CardTab } from "./card-head";
import s from "./card.module.css";
import { EmployeeWarnings } from "./employee-warnings";
import { EndActions } from "./end-actions";
import type { Card } from "./use-card";

type Detail = components["schemas"]["EmployeeDetail"];
const TABS: CardTab[] = ["card", "events", "docs", "ledger", "access"];
const PATH_SEP = " › ";
const META_SEP = " · ";

export function CardConsoleNotes({
  d,
  c,
  facts,
  next,
  documents,
  certsCount,
  eligibleInvite,
  itemsCount,
  open,
  onTab,
}: {
  d: Detail;
  c: Card;
  facts: string;
  next: { date: string; what: string; by?: string | null } | null | undefined;
  documents: boolean;
  certsCount?: number;
  eligibleInvite: boolean;
  itemsCount: number;
  open: (next: string, from?: string) => void;
  onTab: (t: CardTab) => void;
}) {
  const navigate = useNavigate();
  const { e } = c;
  return (
    <>
      <RecordBannerBand>
        <div className={s.path} role="group" aria-label={t("empCard.place")}>
          <Building2 className={s.pathIcon} size={13} aria-hidden="true" />
          {e.legal_entity_id ? (
            <Link to="/org/entities/$id" params={{ id: e.legal_entity_id }}>
              {c.place.entity}
            </Link>
          ) : (
            c.place.entity
          )}
          {c.place.workplace ? (
            <>
              <MapPin className={s.pathIcon} size={13} aria-hidden="true" />
              {e.workplace_id && e.legal_entity_id ? (
                <Link to="/org/entities/$id" params={{ id: e.legal_entity_id }} search={{ wp: e.workplace_id }}>
                  {c.place.workplace}
                </Link>
              ) : (
                c.place.workplace
              )}
            </>
          ) : null}
          {c.place.path.map((x, i) => (
            <bdi key={x + i}>
              {PATH_SEP}
              {i === c.place.path.length - 1 ? <strong>{x}</strong> : x}
            </bdi>
          ))}
          {facts ? (
            <bdi className={s.facts} title={facts}>
              {facts}
            </bdi>
          ) : null}
        </div>
        <div className={s.next} role="group" aria-label={t("empCard.next.label")}>
          <CalendarDays size={13} aria-hidden="true" />
          {next ? (
            <>
              {t("empCard.next.label")} <strong className={s.nextWhat}>{t("empCard.next.what", { date: fmtDate(next.date), what: next.what })}</strong>
              {next.by ? (
                <bdi>
                  {META_SEP}
                  {next.by}
                </bdi>
              ) : null}
            </>
          ) : (
            t("empCard.next.none")
          )}
        </div>
        <EmployeePayLink employeeId={e.id} />
        {e.status !== "EXITED" && (c.readable || c.users) ? (
          <div className="row">
            {c.readable ? <EndActions id={e.id} onAct={open} onOpenCase={() => (onTab("card"), focusSoon("exit"))} /> : null}
            {c.users && eligibleInvite ? (
              <Button
                size="sm"
                onClick={() => void navigate({ to: "/people", search: { view: "accounts", act: "invite", employee: e.id } })}
              >
                <UserPlus size={14} aria-hidden="true" /> {t("people.account.invite")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </RecordBannerBand>

      {e.status === "EXITED" ? (
        <RecordBannerBand tone="warn">
          <div className={s.retention} role="note">
            <bdi>
              {t("empCard.leave.exited", {
                date: fmtDate(e.exit_date ? retirementDate(e.exit_date) : e.exit_date),
                until: d.retention?.kept_until ? fmtDate(d.retention.kept_until) : t("exit.legal.review"),
              })}
            </bdi>
            {d.retention ? (
              <details>
                <summary>{t("exit.legal.reason")}</summary>
                <bdi>{[d.retention.rule.instrument, d.retention.rule.article].filter(Boolean).join(" ")}</bdi>
              </details>
            ) : null}
            {d.retention?.rule.release_disposition !== "RELEASED" ? <Chip tone="warn">{t("exit.legal.review")}</Chip> : null}
            <Button size="sm" variant="ghost" onClick={() => (onTab("card"), focusSoon("exit"))}>
              {t("person.exit.open")}
            </Button>
          </div>
        </RecordBannerBand>
      ) : null}

      <EmployeeWarnings warnings={d.warnings} />

      <TabNav label={t("empCard.tabs")} overflow="scroll">
        {TABS.filter(x => x !== "docs" || documents).map(x => (
          <Link
            key={x}
            to="/people/$id"
            params={{ id: e.id }}
            search={prev => ({ ...prev, tab: x === "card" ? undefined : x })}
            replace
            className={tabClass}
            activeOptions={{ exact: true, includeSearch: true }}
          >
            {t(`empCard.tab.${x}`)}
            {x === "events" ? <TabCount>{itemsCount}</TabCount> : null}
            {x === "docs" && certsCount !== undefined ? <TabCount>{certsCount}</TabCount> : null}
          </Link>
        ))}
      </TabNav>
    </>
  );
}
