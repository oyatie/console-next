import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { PageHead } from "../../../ui/page-head/page-head";
import { buttonClass } from "../../../ui/button/button-class";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { isDate } from "../../../ui/date/days";
import { workplacesQuery } from "../../../reference/statutory/api";
import { QueryState } from "../../../lib/react/query-state";
import { Tabs } from "../../../ui/tabs/tabs";
import { SelectField } from "../../../ui/select/select-field";
import { DateField } from "../../../ui/date/date-field";
import { EmptyState } from "../../../ui/empty-state";
import { FilingList } from "./filing-list";
import { WorkerRegister } from "./worker-register";
import s from "./statutory.module.css";

export function StatutoryPage() {
  const search = useSearch({ from: "/app/statutory" });
  const navigate = useNavigate({ from: "/statutory" });
  const tab = search.tab ?? "insurance";
  const today = todayKst();
  const date = search.date && isDate(search.date) ? search.date : today;
  const validDate = date <= today;
  const entities = useQuery({ ...workplacesQuery(validDate ? date : today), placeholderData: keepPreviousData });
  const change = (next: Partial<typeof search>) => void navigate({ search: { ...search, ...next }, replace: true });
  return <div className="page">
    <PageHead title={t("statutory.title")} />
    <PageReadGate q={entities}>
    <Tabs label={t("statutory.title")} selected={tab} onSelect={(id) => change({ tab: id === "register" ? "register" : undefined })}
      items={[{ id: "insurance", label: t("statutory.insurance") }, { id: "register", label: t("statutory.register") }]}>
      {(id) => <div className="form">
        <div className={s.workplace}><SelectField label={t("statutory.workplace")} required={id === "register"}
          placeholder={t("statutory.pickWorkplace")} value={search.site ?? (id === "insurance" ? "all" : null)}
          options={[...(id === "insurance" ? [{ id: "all", label: t("statutory.all") }] : []), ...(entities.data ?? []).map((w) => ({ id: w.id, label: `${w.entity_name ?? ""} · ${w.name}` }))]}
          onChange={(site) => change({ site: site === "all" ? undefined : site })} /></div>
        {id === "register" && <DateField label={t("statutory.asOf")} required value={date} onChange={(d) => change({ date: d })}
          today={today} max={today} presets={[{ label: t("statutory.today"), date: today }]} />}
        {id === "insurance" ? <FilingList workplaces={entities} site={search.site} event={search.event} filing={search.filing} /> : !validDate ? null : search.site ?
          <WorkerRegister workplaces={entities} site={search.site} date={date} /> :
          <QueryState q={entities} layout="list">{() =>
          <EmptyState title={t("statutory.noSite")} reason={t("statutory.noSiteReason")} actions={<Link to="/org" className={buttonClass()}>{t("statutory.openStructure")}</Link>} />}</QueryState>}
      </div>}
    </Tabs>
    </PageReadGate>
  </div>;
}
