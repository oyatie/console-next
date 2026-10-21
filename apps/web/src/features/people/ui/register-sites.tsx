import { Building2 } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { GroupedChoice } from "../../../ui/choice/grouped-choice";
import type { Site, useSites } from "./use-register-sites";

/**
 * The workplace rail (E10-register): companies as headings, each workplace with its register's people (workers + exited),
 * one picked at a time (a register is per workplace, Labor Standards Act §41(1)). Nothing preselected.
 */
export function SiteRail({ groups, value, onChange }: { groups: ReturnType<typeof useSites>; value: string | null; onChange: (id: string) => void }) {
  const count = (x: Site) => (x.workers === undefined || x.exited === undefined ? t("empDoc.reg.counting") : t("empDoc.reg.siteCount", { workers: fmtNumber(x.workers), exited: fmtNumber(x.exited) }));
  return (
    <GroupedChoice
      id="reg-site"
      label={t("empDoc.reg.site")}
      value={value}
      onChange={onChange}
      groups={groups.map((g) => ({
        id: g.id,
        title: <><Building2 size={14} aria-hidden /> {g.name}</>,
        meta: t("empDoc.reg.siteN", { count: g.sites.length }),
        options: g.sites.map((x) => ({ value: x.id, label: x.name, meta: count(x), name: `${x.entity} › ${x.name} · ${count(x)}` })),
      }))}
    />
  );
}
