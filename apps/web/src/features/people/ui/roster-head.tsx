import type { ReactNode } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { FileSpreadsheet, Plus, Settings2, Upload } from "lucide-react";
import { fmtDate } from "@console/i18n/format";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { ToggleButton } from "../../../ui/button/button";
import { MenuButton } from "../../../ui/menu/menu-button";
import { Kbd } from "../../../ui/record/record-section";
import { buttonClass } from "../../../ui/button/button-class";
import { VIEWS, type Review, type StatusView, type View } from "../domain/roster";
import { useQuery } from "@tanstack/react-query";
import { checklistRef } from "../../../reference/entity/api";
import { Band } from "../../../ui/band/band";
import { AsOf } from "../../../ui/page-head/as-of";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { PageHead } from "../../../ui/page-head/page-head";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import s from "./roster.module.css";

const route = getRouteApi("/app/people");

/**
 * The roster's phase, today's as-of fact, commands and built-in filter views, with its accounts switch.
 */
export function RosterHead({ manage, status, review, onView, actions, switcher, unplaced = false }: {
  manage: boolean;
  status: StatusView;
  review: readonly Review[];
  onView: (v: View) => void;
  /** The roster's own commands that keep their component (export dialog). */
  actions?: ReactNode;
  /** The employees/accounts switch, when the reader has both. */
  switcher?: ReactNode;
  unplaced?: boolean;
}) {
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const access = useQuery(myAccessQuery);
  const { peopleAccess } = route.useRouteContext();
  const navigate = useNavigate({ from: "/people" });
  const view = VIEWS.find((v) => v.status === status && (v.review ?? []).join() === review.join())?.id ?? null;
  return (
    <Band className={s.band}>
      <PageHead title={t(unplaced ? "roster.view.unplaced" : "roster.page.roster")} meta={<>
        <PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "roster.head.setup" : "roster.head.op")}</PhaseLine>
      </>} asOf={<AsOf label={t("roster.head.asof")} date={fmtDate(todayKst())} today={t("roster.head.today")} />} actions={manage && (
          <>
            <Link className={buttonClass()} to="/people/import"><Upload size={16} aria-hidden /> {t("roster.head.import")}</Link>
            {actions}
            <Link className={buttonClass()} to="/people/certificates" search={{}}>{t("empDoc.certificate.register")}</Link>
            <Link className={buttonClass()} from="/people" to="/people" search={(prev) => ({ ...prev, tab: "appointments", bulk: "paste" })}><FileSpreadsheet size={16} aria-hidden /> {t("bulk.openPaste")}</Link>
            <MenuButton
              label={t("roster.head.settings")}
              icon={<Settings2 size={16} aria-hidden />}
              items={[
                { id: "/people/numbering", text: t("people.numbering"), label: t("people.numbering") },
                { id: "/people/job-titles", text: t("titles.title"), label: t("titles.title") },
              ]}
              onAction={(to) => void navigate({ to })}
            />
            <Link className={buttonClass("primary")} to="/people/new" search={{}}><Plus size={16} aria-hidden /> {t("people.register")} <Kbd k="A" /></Link>
          </>
        )} tabs={<div className={s.views} role="group" aria-label={t("roster.view.label")}>
        {VIEWS.filter((v) => v.status).map((v) => <ToggleButton key={v.id} pressed={!unplaced && view === v.id} onClick={() => onView(v)}>{t(`roster.view.${v.id}`)}</ToggleButton>)}
        {access.data && accessRefusal(access.data, peopleAccess.unplaced) === null && <ToggleButton pressed={unplaced} onClick={() => void navigate({ to: "/people", search: previous => ({ ...previous, placement: unplaced ? undefined : "unplaced", sel: undefined }), replace: true })}>{t("roster.view.unplaced")}</ToggleButton>}
        {switcher}
      </div>} />
    </Band>
  );
}
