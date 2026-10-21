import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileSpreadsheet, FileText, Plus, Settings2, Upload } from "lucide-react";
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
import s from "./roster.module.css";

/**
 * The people head (E1): the title with headcount and the phase, as-of date (today only: an as-of read is not served), the commands
 * with their keys, then the view tabs (built-in views; "save view" waits for the view store) and the accounts switch.
 */
export function RosterHead({ headcount, manage, status, review, onView, actions, switcher }: {
  headcount?: number;
  manage: boolean;
  status: StatusView;
  review: readonly Review[];
  onView: (v: View) => void;
  /** The roster's own commands that keep their component (export dialog). */
  actions?: ReactNode;
  /** The employees/accounts switch, when the reader has both. */
  switcher?: ReactNode;
}) {
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const navigate = useNavigate();
  const view = VIEWS.find((v) => v.status === status && (v.review ?? []).join() === review.join())?.id ?? null;
  return (
    <Band as="header" className={s.band}>
      <div className={s.titleRow}>
        <h1 id="people-title" className={s.title} tabIndex={-1}>{t("roster.head.title")}</h1>
        <span className={s.headcount}>{headcount !== undefined && t("roster.head.count", { count: headcount })}</span>
        <PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "roster.head.setup" : "roster.head.op")}</PhaseLine>
        <span className="grow" />
        <AsOf label={t("roster.head.asof")} date={fmtDate(todayKst())} today={t("roster.head.today")} locked={t("roster.head.asofLocked")} />
        {manage && (
          <>
            <Link className={buttonClass()} to="/people/import"><Upload size={16} aria-hidden /> {t("roster.head.import")}</Link>
            {actions}
            <Link className={buttonClass()} from="/people" to="/people" search={(prev) => ({ ...prev, export: "register" })}><FileText size={16} aria-hidden /> {t("roster.head.register")}</Link>
            <Link className={buttonClass()} from="/people" to="/people" search={(prev) => ({ ...prev, bulk: "paste" })}><FileSpreadsheet size={16} aria-hidden /> {t("bulk.openPaste")}</Link>
            <MenuButton
              label={t("roster.head.settings")}
              icon={<Settings2 size={16} aria-hidden />}
              caret={false}
              items={[
                { id: "/people/numbering", text: t("people.numbering"), label: t("people.numbering") },
                { id: "/people/job-titles", text: t("titles.title"), label: t("titles.title") },
              ]}
              onAction={(to) => void navigate({ to })}
            />
            <Link className={buttonClass("primary")} to="/people/new" search={{}}><Plus size={16} aria-hidden /> {t("people.register")} <Kbd k="A" /></Link>
          </>
        )}
      </div>
      <div className={s.views} role="group" aria-label={t("roster.view.label")}>
        {VIEWS.filter((v) => v.status).map((v) => <ToggleButton key={v.id} pressed={view === v.id} onClick={() => onView(v)}>{t(`roster.view.${v.id}`)}</ToggleButton>)}
        {manage && <Link className={buttonClass("ghost")} to="/people/unplaced">{t("roster.view.unplaced")}</Link>}
        <span className="grow" />
        {switcher}
      </div>
    </Band>
  );
}
