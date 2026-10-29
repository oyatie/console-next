import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { grantsQuery, meQuery, rolesQuery } from "../api";

/**
 * The access page head: title, the phase line (grants wait for go-live while SETUP lasts) and the three views, the
 * first two with their counts (mockup M1). A person's access sits under the grants view. `sub` is the view's lede.
 */
export function AccessHead({ actions, sub }: { actions?: ReactNode; sub?: ReactNode }) {
  const me = useQuery(meQuery);
  const roles = useQuery(rolesQuery);
  const grants = useQuery(grantsQuery());
  const path = useRouterState({ select: (r) => r.location.pathname });
  const phase = me.data?.phase;
  const failed = !!(me.error || roles.error || grants.error);
  return (
    <PageHead
      title={t("access.title")}
      meta={phase && <PhaseLine phase={phase === "SETUP" ? "setup" : "operating"}>{t(phase === "SETUP" ? "access.phase.setup" : "access.phase.operating")}</PhaseLine>}
      tools={failed ? undefined : actions}
      sub={sub}
      tabs={
        <TabNav label={t("access.nav")}>
          {/* Held empty until the count lands, so the tabs never move under a pointer. */}
          <Link to="/access/roles" className={tabClass}>{t("access.nav.roles")}<TabCount>{failed ? undefined : roles.data?.items.length}</TabCount></Link>
          <Link to="/access/grants" className={tabClass} aria-current={path.startsWith("/access/people/") ? "true" : undefined}>{t("access.nav.grants")}<TabCount>{failed ? undefined : grants.data?.items.length}</TabCount></Link>
          <Link to="/access/ready" className={tabClass}>{t("access.nav.ready")}</Link>
        </TabNav>
      }
    />
  );
}
