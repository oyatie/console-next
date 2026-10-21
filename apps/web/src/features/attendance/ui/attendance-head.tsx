import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { orgStructureRef } from "../../../reference/entity/api";
import { ChainStepper, type ChainStep } from "../../../ui/chain-stepper/chain-stepper";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabNav } from "../../../ui/tabs/tabs";
import type { Tab } from "./attendance-page";
import s from "./attendance.module.css";

// The close → payroll chain (golden §4): every step stays drawn, each with its owner and an honest state. Until a
// step's slice lands it reads "coming later", never a made-up count (TR-67 / FE-25 restored: ② leave posting is leave's).
const CHAIN = ["close", "leave", "pay", "slip"] as const;

/**
 * The attendance page head: title, phase line, the chain strip, and the attendance tabs. Only built tabs are listed (a tab the
 * product cannot open yet is absent, not a dead link); the TR-73 groups (records | approvals, leave, close | schedules, import, reports, settings)
 * fill in as the slices land.
 */
export function AttendanceHead({ tab }: { tab: Tab }) {
  const org = useQuery(orgStructureRef);
  const phase = org.data?.phase;
  const steps: ChainStep[] = CHAIN.map((k) => ({
    key: k,
    who: <>{t(`attendance.chain.${k}`)} <span className="muted">{t(`attendance.chain.${k}.owner`)}</span></>,
    state: "waiting",
    meta: t("attendance.chain.planned"),
  }));
  return (
    <PageHead
      title={t("attendance.title")}
      meta={phase && <PhaseLine phase={phase === "OPERATING" ? "operating" : "setup"}>{t(phase === "OPERATING" ? "attendance.phase.operating" : "attendance.phase.setup")}</PhaseLine>}
      sub={<ChainStepper label={t("attendance.chain.label")} steps={steps} />}
      tabs={
        <TabNav label={t("attendance.tabs")}>
          {(["month", "day"] as const).map((k) => (
            <Link key={k} to="/attendance" search={{ tab: k }} className={tabClass} aria-current={tab === k ? "page" : undefined}>{t(`attendance.tab.${k}`)}</Link>
          ))}
          <span className={s.divider} aria-hidden />
          <Link to="/attendance" search={{ tab: "schedule" }} className={tabClass} aria-current={tab === "schedule" ? "page" : undefined}>{t("attendance.tab.schedule")}</Link>
        </TabNav>
      }
    />
  );
}
