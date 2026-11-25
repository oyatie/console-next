import { verificationState } from "../present";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Network, PencilLine, Plus } from "lucide-react";
import type { LegalEntity, OrgStructureNode } from "@console/api/pending";
import { t } from "@console/i18n";
import { BIZ_KIND, label } from "../../../lib/labels";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { QueryState } from "../../../lib/react/query-state";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { orgStructureAt } from "../../../reference/entity/api";
import { myAccessQuery } from "../../../reference/authz/api";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { EnumValue } from "../../../ui/enum-value";
import { ENTITY_LIFECYCLE, RECORD_STATUS } from "../../../lib/labels";
import { PageHead } from "../../../ui/page-head/page-head";
import { PagePhase } from "../../../ui/page/page-scope";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RecordPattern } from "../../../ui/patterns/record";
import { Tabs } from "../../../ui/tabs/tabs";
import { entityDocumentsQuery, entityHistoryQuery, entityQuery } from "../api";
import { headcount, officers, primaryRegistration } from "../domain/view";
import { TABS, type Tab } from "../domain/tabs";
import { entityName } from "../../../reference/entity/domain/names";
import { LockNotice } from "./record-lock";
import { lockOf, RecordLockProvider } from "./use-record-lock";
import { FoundingCard } from "./record-founding";
import { DocumentsTab } from "./documents-tab";
import { HistoryTab } from "./history-tab";
import { useHistoryReads } from "./use-history-reads";
import { VoidEntity } from "./void-entity";
import { OriginalSheet } from "./record-original-sheet";
import { WorkplacesTab } from "./workplaces-tab";
import { CertCard, NoCertificate } from "./record-cert-card";
import { CloseSheet } from "./record-close-sheet";
import { CorrectionRegister } from "./correction-register";
import { IdentifierSheet } from "./record-identifier-sheet";
import { ReissueSheet } from "./record-reissue-sheet";
import { OfficersTab } from "./record-officers-tab";
import type { Act } from "./record-revise-sheet";
import { RecordAside } from "./record-aside";
import { RegistryCard } from "./record-registry-card";
import { ReviseSheet, type FieldSpec } from "./record-revise-sheet";
import { VatCard } from "./record-vat-card";
import { WorkplacesCard } from "./record-workplaces-card";
import { AsOfBand } from "./asof-band";
import s from "./record.module.css";

import { EntityName } from "../../../reference/entity/ui/entity-name";
import { NameProblems } from "./name-problems";
import { NameReview } from "./name-review";

const route = getRouteApi("/app/org/entities/$id");

export function EntityScreen() {
  const { id } = route.useParams();
  const { wp } = route.useSearch();
  return <EntityRecord key={`${id}:${wp ?? ""}`} id={id} workplace={wp} />;
}

/**
 * The correction register under the tabs reads at once. Arriving on the history tab, it shows with that tab's first
 * answers, never above them. Elsewhere it shows once it has read: the hold covers the history tab's own sections only,
 * not the overview aside's latest history, which reads the same history in its own column.
 */
function HeldRegister({ e, tab }: { e: LegalEntity; tab: Tab }) {
  return <CorrectionRegister entityId={e.id} hidden={useHistoryReads(e, tab === "history").arriving} />;
}

const countDepts = (n: OrgStructureNode | undefined): number => (n ? n.children.reduce((a, x) => a + (x.kind === "DEPARTMENT" ? 1 : 0) + countDepts(x), 0) : 0);

/**
 * One entity as its record (spec S3): the certificate's items in their printed numbers, registry and entity basics, its workplace
 * and certificates, VAT and worker facts, and beside them where it stands, its history, how it closes and its
 * kept originals. Every fact carries one verb: edit (change (REV) or correction (COR)), correct-only, or an identifier's correction.
 */
export function EntityRecord({ id, workplace }: { id: string; workplace?: string }) {
  const { as_of, known_at, reissue, nts, tab: urlTab } = route.useSearch();
  const navigate = route.useNavigate();
  const point = { as_of, known_at };
  const today = todayKst();
  const temporal = Boolean(known_at) || Boolean(as_of && as_of !== today);
  const read = entityQuery(id, point);
  // A legal entity a command changed since it was cached (a workplace sheet's save) is drawn only once re-read: drawn stale, its
  // facts moved under the next click when the re-read landed.
  const q = useFreshOnArrival(useQuery({ ...read, placeholderData: keepPreviousData }), read);
  const docsQ = useQuery({ ...entityDocumentsQuery(id), retry: false });
  const historyRead = entityHistoryQuery(id);
  const hist = useFreshOnArrival(useQuery({ ...historyRead, retry: false }), historyRead);
  const access = useQuery(myAccessQuery);
  const phase = access.data?.phase;
  const { settled } = useContext(PagePhase);
  const structure = useQuery(orgStructureAt(point));
  const node = structure.data?.entities.find((n) => n.id === id);
  const tab = nts ? "certificates" : urlTab ?? (workplace ? "workplaces" : "overview");
  const setTab = (next: Tab) => void navigate({ search: search => ({ ...search, tab: next, nts: undefined }), replace: true });
  useEffect(() => {
    if (settled && nts && tab === "certificates" && q.isSuccess) requestAnimationFrame(() => document.getElementById(`nts-${nts}`)?.scrollIntoView({ block: "center" }));
  }, [settled, nts, tab, q.isSuccess]);
  const [sheet, setSheet] = useState<ReactNode>(null);
  const [displayed, setDisplayed] = useState(q.data);
  // A conflict re-reads the latest values for its sheet without moving the record behind it.
  if (!sheet && displayed !== q.data) setDisplayed(q.data);
  const close = () => setSheet(null);
  const key = `${id}:${as_of ?? ""}:${known_at ?? ""}`;
  const [opened, setOpened] = useState(key);
  if (key !== opened) { setOpened(key); setSheet(null); }
  const changeDate = (date: string, knownAt?: string) => {
    close();
    void navigate({ search: (search) => ({ ...search, wp: undefined, as_of: date === today ? undefined : date, known_at: knownAt }) });
  };
  const band = <AsOfBand asOf={as_of} knownAt={known_at} onChange={changeDate} />;
  const back = { to: "/org/entities", label: t("denied.entity.back") } as const;
  const removed = t("denied.entity.deleted.reason");
  const operating = phase === "OPERATING";
  const depts = countDepts(node);
  const activeQ = sheet && displayed ? { ...q, data: displayed } : q;

  const buildHeaderParts = (e: LegalEntity) => {
    const primary = primaryRegistration(e);
    const lock = temporal ? "asof" : lockOf(e, phase !== undefined);
    const v = primary ? verificationState(primary) : null;
    const meta = (
      <>
        {e.biz_kind && <Chip tone="neutral">{label(BIZ_KIND, e.biz_kind)}</Chip>}
        {/* company-05: an entity being founded reads as founding alone, never "continuing" beside it. */}
        <EnumValue e={ENTITY_LIFECYCLE} value={e.founding ? "founding" : e.closed_on ? "closed" : "open"} />
        {!e.closed_on && primary?.current?.status === "SUSPENDED" && <EnumValue e={RECORD_STATUS} value="SUSPENDED" />}
        {v && <Chip tone="neutral">{v.label}</Chip>}
      </>
    );
    const secondaryTools = (
      <>
        <Link to="/org" search={point} className="btn"><Network size={16} aria-hidden /> {t("entityRecord.action.chart")}</Link>
        {(!lock || lock === "loading") && <Link to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className="btn" disabled={lock === "loading"}><Plus size={16} aria-hidden /> {t("entityRecord.action.addWorkplace")}</Link>}
      </>
    );
    const notes = (
      <>
        <NameProblems e={e} onCertificate={() => setTab("certificates")} review={(r) => <NameReview key={r.id} e={e} review={r} editable={e.can_manage && !lock} />} />
        <LockNotice e={e} lock={lock === "loading" ? null : lock} />
        {e.can_manage && <QueryState q={access} inline loading={<></>}>{() => null}</QueryState>}
      </>
    );
    return { primary, lock, meta, secondaryTools, notes };
  };

  const buildBodyState = (e: LegalEntity) => {
    const readOnly = temporal || Boolean(e.read_only) || phase === undefined;
    const act: Act = {
      field: <V,>(spec: FieldSpec<V>) => { if (!readOnly) setSheet(<ReviseSheet e={e} spec={spec} phase={phase} onClose={close} />); },
      identifier: (field, registrationId) => { if (!readOnly) setSheet(<IdentifierSheet e={e} field={field} registrationId={registrationId ?? primaryRegistration(e)?.id} operating={operating} onClose={close} />); },
      reissue: (registrationId) => void navigate({ search: (search) => ({ ...search, reissue: registrationId }) }),
      attach: (registrationId) => { if (!readOnly) setSheet(<OriginalSheet entityId={e.id} registrationId={registrationId} onClose={close} />); },
      close: () => { if (!readOnly) setSheet(<CloseSheet e={e} depts={depts} onClose={close} />); },
      remove: () => { if (!readOnly) setSheet(<VoidEntity e={e} onClose={close} />); },
    };
    const primary = primaryRegistration(e);
    const docs = docsQ.isSuccess ? docsQ.data.items : null;
    const counts = {
      certificates: e.registrations.length,
      workplaces: e.workplaces.length,
      officers: officers(e).length,
      documents: docsQ.data?.items.length ?? "",
      history: hist.data?.items.length ?? "",
    };
    const reissuing = reissue ? e.registrations.find((r) => r.id === reissue && !r.closed_on) : undefined;
    const renderTab = (selected: string, flat: boolean) => (
      <>
        {selected === "overview" && (
          <div className={s.col}>
            {e.founding && <FoundingCard e={e} flat={flat} />}
            {primary ? <CertCard e={e} r={primary} act={act} operating={operating} onOriginal={docs?.length ? () => setTab("documents") : undefined} flat={flat} /> : <NoCertificate e={e} flat={flat} />}
            <RegistryCard e={e} act={act} flat={flat} />
            <WorkplacesCard e={e} flat={flat} />
            <VatCard e={e} act={act} flat={flat} />
          </div>
        )}
        {selected === "certificates" && (
          <div className={s.wide}>
            {e.registrations.map((r) => <CertCard showCheck key={r.id} e={e} r={r} act={act} operating={operating} onOriginal={docs?.length ? () => setTab("documents") : undefined} flat={flat} />)}
            {e.registrations.length === 0 && <NoCertificate e={e} flat={flat} />}
          </div>
        )}
        {selected === "workplaces" && <div className={s.wide}><WorkplacesTab e={e} selected={workplace} flat={flat} /></div>}
        {selected === "officers" && <div className={s.wide}><OfficersTab e={e} act={act} flat={flat} /></div>}
        {selected === "documents" && <div className={s.wide}><QueryState q={docsQ}>{data => <DocumentsTab docs={data.items} flat={flat} />}</QueryState></div>}
        {selected === "history" && <div className={s.wide}><HistoryTab e={e} flat={flat} /></div>}
      </>
    );
    const overlays = (
      <>
        {!readOnly && sheet}
        {!readOnly && reissuing && <ReissueSheet e={e} r={reissuing} phase={phase} onClose={() => void navigate({ search: (search) => ({ ...search, reissue: undefined }), replace: true })} />}
      </>
    );
    return { readOnly, act, docs, counts, renderTab, overlays };
  };

  const renderBaselineHead = (e: LegalEntity, tabs: ReactNode) => {
    const { lock, meta, secondaryTools, notes } = buildHeaderParts(e);
    return (
      <PageHead band
        title={<EntityName entity={e} />}
        crumbs={<Crumbs items={[<Link key="entities" to="/org/entities" search={point}>{t("entity.list.title")}</Link>]} current={entityName(e)} />}
        meta={meta}
        tools={<>
          {secondaryTools}
          {(!lock || lock === "loading") && <Button variant="primary" disabled={lock === "loading"} onClick={() => setTab("certificates")}><PencilLine size={16} aria-hidden /> {t("entityRecord.action.editByCert")}</Button>}
        </>}
        sub={notes}
        tabs={tabs}
      />
    );
  };

  const renderBaseline = () => (
    <div className={s.page}><PageReadGate q={q} title={t("entity.list.title")} back={back} removed={removed}>{band}
    <QueryState q={activeQ} back={back} removed={removed} layout="record">
      {(e) => {
        const { lock } = buildHeaderParts(e);
        const { readOnly, act, docs, counts, renderTab, overlays } = buildBodyState(e);
        return (
          <RecordLockProvider key={id} value={lock}>
          <>
            <Tabs label={t("entityRecord.tabs")} selected={tab} onSelect={next => setTab(next as Tab)} renderList={tabs => renderBaselineHead(e, tabs)} items={TABS.map(x => ({ id: x, label: t(`entityRecord.tab.${x}`), count: x === "overview" ? undefined : counts[x] }))}>
              {selected => (
                <div className={s.body}>
                  {renderTab(selected, false)}
                  {selected === "overview" && <RecordAside e={e} phase={phase} depts={depts} docs={docs} act={act} onTab={setTab} />}
                </div>
              )}
            </Tabs>
            {!readOnly && <HeldRegister e={e} tab={tab} />}
            {overlays}
          </>
          </RecordLockProvider>
        );
      }}
    </QueryState>
    </PageReadGate></div>
  );

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() => {
        const e = activeQ.data;
        if (!e) return <RecordPattern q={activeQ} head={{ title: t("entity.list.title"), asOf: band }} back={back} removed={removed} sections={null} />;
        const { lock, meta, secondaryTools, notes } = buildHeaderParts(e);
        const { readOnly, act, docs, counts, renderTab, overlays } = buildBodyState(e);
        return (
          <RecordLockProvider key={id} value={lock}>
            <Tabs label={t("entityRecord.tabs")} selected={tab} onSelect={next => setTab(next as Tab)}
              items={TABS.map(x => ({ id: x, label: t(`entityRecord.tab.${x}`), count: x === "overview" ? undefined : counts[x] }))}
              renderLayout={(list, panels) => (
                <RecordPattern
                  q={activeQ}
                  back={back}
                  removed={removed}
                  head={{
                    title: <EntityName entity={e} />,
                    crumbs: <Crumbs items={[<Link key="entities" to="/org/entities" search={point}>{t("entity.list.title")}</Link>]} current={entityName(e)} />,
                    asOf: band,
                    meta,
                    tools: secondaryTools,
                    primary: (!lock || lock === "loading") ? {
                      id: "edit-by-cert",
                      label: t("entityRecord.action.editByCert"),
                      icon: <PencilLine size={16} aria-hidden />,
                      disabled: lock === "loading",
                      onAction: () => setTab("certificates"),
                    } : undefined,
                    tabs: list,
                  }}
                  notes={notes}
                  sections={panels}
                  spine={tab === "overview" ? <RecordAside e={e} phase={phase} depts={depts} docs={docs} act={act} onTab={setTab} flat /> : undefined}
                  foot={!readOnly ? <HeldRegister e={e} tab={tab} /> : undefined}
                  overlays={overlays}
                  statusSegments={[
                    { id: "entity", tone: "strong", content: entityName(e) },
                    { id: "workplaces", content: t("entity.count.workplaces", { count: e.workplaces.length }) },
                    { id: "people", content: t("entity.count.people", { count: headcount(e) }) },
                  ]}
                />
              )}>
              {selected => renderTab(selected, true)}
            </Tabs>
          </RecordLockProvider>
        );
      }}
    </ExperienceSwitch>
  );
}
