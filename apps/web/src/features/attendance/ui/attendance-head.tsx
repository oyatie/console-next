import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { orgStructureRef } from "../../../reference/entity/api";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabNav } from "../../../ui/tabs/tabs";
import type { Tab } from "./attendance-page";

/**
 * The attendance page head: title, phase line and available tabs. The chain waits for served steps. Only built tabs are listed (a tab the
 * product cannot open yet is absent, not a dead link); the TR-73 groups (records | approvals, leave, close | schedules, import, reports, settings)
 * fill in as the slices land.
 */
export function AttendanceHead({ tab }: { tab: Tab }) {
  const org = useQuery(orgStructureRef);
  const phase = org.data?.phase;
  return (
    <PageHead
      title={t("attendance.title")}
      meta={phase && <PhaseLine phase={phase === "OPERATING" ? "operating" : "setup"}>{t(phase === "OPERATING" ? "attendance.phase.operating" : "attendance.phase.setup")}</PhaseLine>}
      tabs={
        <TabNav label={t("attendance.tabs")} overflow="scroll">
          {(["day", "month", "overtime", "schedule", "issues", "close"] as const).map((k) => (
            <Link key={k} from="/attendance" to="/attendance" search={search => ({ ...search, tab: k, person: undefined })} className={tabClass} aria-current={(tab === "week" ? "overtime" : tab) === k ? "page" : undefined}>{t(`attendance.tab.${k}`)}</Link>
          ))}
        </TabNav>
      }
    />
  );
}
