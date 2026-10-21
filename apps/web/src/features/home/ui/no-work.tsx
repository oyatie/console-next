import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { EmptyState } from "../../../ui/empty-state";

/**
 * An account that holds no work grant (in the pilot only ops and HR workers sign in, decisions #18): no queue, lanes
 * or quick links it cannot use; only its own account. Signing out stays where it always is, in the top bar.
 */
export function NoWork() {
  return (
    <section className="card" data-testid="home-no-work">
      <EmptyState
        title={t("home.noWork.title")}
        reason={t("home.noWork.reason")}
        actions={<Link to="/account" className="btn btn--primary">{t("shell.account")}</Link>}
      />
    </section>
  );
}
