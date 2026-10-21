import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { EmptyState } from "../../../ui/empty-state";
import { buttonClass } from "../../../ui/button/button-class";
import u from "./unplaced-extra.module.css";

/**
 * Nobody is left unplaced (r3:EMP-E12-queue-empty): said as done, with what to do next, never a dead end.
 * `placed` is how many this visit placed (0 when the queue was empty on arrival).
 */
export function UnplacedDone({ placed }: { placed: number }) {
  return (
    <div className={u.gutter}>
      <EmptyState
        title={placed > 0 ? t("unplaced.finished.title", { n: placed }) : t("unplaced.empty.title")}
        reason={t("unplaced.empty.reason")}
        actions={
          <>
            <Link to="/people" search={{}} className={buttonClass("primary")}>{t("unplaced.finished.roster")}</Link>
            <Link to="/org" className={buttonClass("secondary")}>{t("unplaced.finished.structure")}</Link>
            <Link to="/people/import" className={buttonClass("ghost")}>{t("unplaced.finished.import")}</Link>
          </>
        }
      />
    </div>
  );
}
