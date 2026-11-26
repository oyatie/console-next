import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { PageHead } from "../../../ui/page-head/page-head";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabNav } from "../../../ui/tabs/tabs";
import type { Tab } from "./attendance-page";
import { useAttendancePhaseLine } from "./use-attendance-phase-line";
import s from "./attendance-console.module.css";

/**
 * The attendance page head: title, phase line and available tabs. The chain waits for served steps. Only built tabs are listed (a tab the
 * product cannot open yet is absent, not a dead link); the TR-73 groups (records | approvals, leave, close | schedules, import, reports, settings)
 * fill in as the slices land.
 */
export function AttendanceTabNav({ tab }: { tab: Tab }) {
  return (
    <div className={s.tabNavWrap}>
      <TabNav label={t("attendance.tabs")} overflow="scroll">
        {(["day", "month", "overtime", "schedule", "issues", "close", "import"] as const).map((k) => (
          <Link key={k} from="/attendance" to="/attendance" search={search => ({ ...search, tab: k, person: undefined })} className={tabClass} aria-current={(tab === "week" ? "overtime" : tab) === k ? "page" : undefined}>{t(`attendance.tab.${k}`)}</Link>
        ))}
      </TabNav>
    </div>
  );
}

export function AttendanceHead({ tab }: { tab: Tab }) {
  const phaseLine = useAttendancePhaseLine();
  return <PageHead title={t("attendance.title")} meta={phaseLine} tabs={<AttendanceTabNav tab={tab} />} />;
}
