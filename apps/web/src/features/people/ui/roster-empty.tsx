import { Link } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/record/record-section";
import { buttonClass } from "../../../ui/button/button-class";

/**
 * Nobody matches (E1-empty): what was asked, then every way on — drop the filters, look among the exited (they are kept
 * apart for 3 years, never in this list), or register the person if they are not on file yet.
 */
export function RosterEmpty({ q, narrowed, exited, manage, onReset, onExited }: { q?: string; narrowed: boolean; exited: boolean; manage: boolean; onReset: () => void; onExited: () => void }) {
  const reason = q && narrowed ? t("people.noMatch.both", { q }) : q ? t("people.noMatch.reason", { q }) : t("people.noMatch.filters");
  return (
    <EmptyState
      title={q ? t("roster.empty.q", { q }) : t("people.noMatch.title")}
      reason={exited ? reason : `${reason} ${t("roster.empty.exited")}`}
      actions={
        <>
          <Button onClick={onReset}>{t("people.filter.reset")}</Button>
          {!exited && <Button onClick={onExited}><Search size={14} aria-hidden /> {t("roster.empty.inExited")}</Button>}
          {manage && <Link className={buttonClass()} to="/people/new" search={{}}><Plus size={14} aria-hidden /> {t("people.register")} <Kbd k="A" /></Link>}
        </>
      }
    />
  );
}
