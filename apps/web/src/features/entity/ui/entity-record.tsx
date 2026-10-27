import { verificationState } from "../present";
import { useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Network, PencilLine, Plus } from "lucide-react";
import type { LegalEntity, OrgStructureNode } from "@console/api/pending";
import { t } from "@console/i18n";
import { BIZ_KIND, label } from "../../../lib/labels";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { QueryState } from "../../../lib/react/query-state";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { checklistRef, orgStructureAt } from "../../../reference/entity/api";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { PageHead } from "../../../ui/page-head/page-head";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { Tabs } from "../../../ui/tabs/tabs";
import { entityDocumentsQuery, entityHistoryQuery, entityQuery } from "../api";
import { officers, primaryRegistration } from "../domain/view";
import { TABS, type Tab } from "../domain/tabs";
import { entityName } from "../../../reference/entity/domain/names";
import { unattached } from "../domain/attach";
import { LockNotice } from "./record-lock";
import { lockOf, RecordLockProvider, useRecordLock } from "./use-record-lock";
import { AttachHost } from "./workplace-attach-sheet";
import { FoundingCard } from "./record-founding";
import { DocumentsTab } from "./documents-tab";
import { HistoryTab } from "./history-tab";
import { VoidEntity } from "./void-entity";
import { OriginalSheet } from "./record-original-sheet";
import { WorkplacesTab } from "./workplaces-tab";
import { CertCard } from "./record-cert-card";
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
  const phaseQ = useQuery(checklistRef);
  const phase = phaseQ.data?.phase;
  const structure = useQuery(orgStructureAt(point));
  const node = structure.data?.entities.find((n) => n.id === id);
  const tab = nts ? "certificates" : urlTab ?? (workplace ? "workplaces" : "overview");
  const setTab = (next: Tab) => void navigate({ search: search => ({ ...search, tab: next, nts: undefined }), replace: true });
  useEffect(() => {
    if (nts && tab === "certificates" && q.isSuccess) requestAnimationFrame(() => document.getElementById(`nts-${nts}`)?.scrollIntoView({ block: "center" }));
  }, [nts, tab, q.isSuccess]);
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
  const operating = phase === "OPERATING";
  const depts = countDepts(node);
  const head = (e: LegalEntity, tabs: ReactNode) => {
    const primary = primaryRegistration(e);
    const lock = temporal ? "asof" : lockOf(e, phase !== undefined);
    const v = primary ? verificationState(primary) : null;
    return (
      <PageHead band
        title={<EntityName entity={e} />}
        crumbs={<Crumbs items={[<Link key="entities" to="/org/entities" search={point}>{t("entity.list.title")}</Link>]} current={entityName(e)} />}
        meta={<>
          {e.biz_kind && <Chip tone="neutral">{label(BIZ_KIND, e.biz_kind)}</Chip>}
          {/* company-05: an entity being founded reads as founding alone, never "continuing" beside it. */}
          {e.founding ? <Chip tone="info">{t("entityOps.founding.chip")}</Chip> : <Chip tone={e.closed_on ? "neutral" : "ok"}>{t(e.closed_on ? "entityRecord.status.closed" : "entityRecord.status.open")}</Chip>}
          {!e.closed_on && primary?.current?.status === "SUSPENDED" && <Chip tone="warn">{t("enum.recordStatus.SUSPENDED")}</Chip>}
          {v && <Chip tone="neutral">{v.label}</Chip>}
        </>}
        tools={<>
          <Link to="/org" search={point} className="btn"><Network size={16} aria-hidden /> {t("entityRecord.action.chart")}</Link>
          {(!lock || lock === "loading") && <Link to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className="btn" disabled={lock === "loading"}><Plus size={16} aria-hidden /> {t("entityRecord.action.addWorkplace")}</Link>}
          {(!lock || lock === "loading") && <Button variant="primary" disabled={lock === "loading"} onClick={() => setTab("certificates")}><PencilLine size={16} aria-hidden /> {t("entityRecord.action.editByCert")}</Button>}
        </>}
        sub={<>
          <div className={s.nameProblems}><NameProblems e={e} onCertificate={() => setTab("certificates")} review={(r) => <NameReview key={r.id} e={e} review={r} editable={e.can_manage && !lock} />} /></div>
          <LockNotice e={e} lock={lock === "loading" ? null : lock} />
          {e.can_manage && <QueryState q={phaseQ} inline loading={<></>}>{() => null}</QueryState>}
        </>}
        tabs={tabs}
      />
    );
  };
  return (
    <div className={s.page}><PageReadGate q={q} title={t("entity.list.title")} back={{ to: "/org/entities", label: t("denied.entity.back") }} removed={t("denied.entity.deleted.reason")}>{band}
    <QueryState q={sheet && displayed ? { ...q, data: displayed } : q} back={{ to: "/org/entities", label: t("denied.entity.back") }} removed={t("denied.entity.deleted.reason")} layout="record">
      {(e) => {
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
        return (
          <RecordLockProvider key={id} value={temporal ? "asof" : lockOf(e, phase !== undefined)}>
          <>
            <Tabs label={t("entityRecord.tabs")} selected={tab} onSelect={next => setTab(next as Tab)} renderList={list => head(e, list)}
              items={TABS.map(x => ({ id: x, label: t(`entityRecord.tab.${x}`), count: x === "overview" ? undefined : counts[x] }))}>
              {selected => <div className={s.body}>
              {selected === "overview" && (
                <>
                  <div className={s.col}>
                    {e.founding && <FoundingCard e={e} />}
                    {primary ? <CertCard e={e} r={primary} act={act} operating={operating} onOriginal={docs?.length ? () => setTab("documents") : undefined} /> : <NoCertificate e={e} />}
                    <RegistryCard e={e} act={act} />
                    <WorkplacesCard e={e} />
                    <VatCard e={e} act={act} />
                  </div>
                  <RecordAside e={e} phase={phase} depts={depts} docs={docs} act={act} onTab={setTab} />
                </>
              )}
              {selected === "certificates" && (
                <div className={s.wide}>
                  {e.registrations.map((r) => <CertCard showCheck key={r.id} e={e} r={r} act={act} operating={operating} onOriginal={docs?.length ? () => setTab("documents") : undefined} />)}
                  {e.registrations.length === 0 && <NoCertificate e={e} />}
                </div>
              )}
              {selected === "workplaces" && <div className={s.wide}><WorkplacesTab e={e} selected={workplace} /></div>}
              {selected === "officers" && <div className={s.wide}><OfficersTab e={e} act={act} /></div>}
              {selected === "documents" && <div className={s.wide}><QueryState q={docsQ}>{data => <DocumentsTab docs={data.items} />}</QueryState></div>}
              {selected === "history" && <div className={s.wide}><HistoryTab e={e} /></div>}
            </div>}
            </Tabs>
            {!readOnly && <CorrectionRegister entityId={e.id} />}
            {!readOnly && sheet}
            {!readOnly && reissuing && <ReissueSheet e={e} r={reissuing} phase={phase} onClose={() => void navigate({ search: (search) => ({ ...search, reissue: undefined }), replace: true })} />}
          </>
          </RecordLockProvider>
        );
      }}
    </QueryState>
    </PageReadGate></div>
  );
}

/**
 * No certificate recorded yet: a to-do with its way in. A workplace that files under none takes its own here (org-03);
 * with no workplace yet, the first workplace carries it.
 */
function NoCertificate({ e }: { e: LegalEntity }) {
  const [attaching, setAttaching] = useState(false);
  const first = unattached([e])[0]?.w;
  const open = !useRecordLock();
  return (
    <section className="card" aria-labelledby="nocert-title">
      <div className={s.cardHead}><h2 id="nocert-title" className={s.cardTitle}>{t("entityRecord.cert.title")}</h2><Chip tone="warn">{t("entityRecord.cert.missing")}</Chip></div>
      <div className={s.cardBody}>
        <p className="muted">{t("entityRecord.cert.missingWhy")}</p>
        {open && first && (
          <Button variant="primary" onClick={() => setAttaching(true)} aria-label={t("entityOps.attach.actionOf", { name: first.current?.name ?? "" })}>
            <Plus size={16} aria-hidden /> {t("entityOps.attach.actionOf", { name: first.current?.name ?? "" })}
          </Button>
        )}
        {open && !first && <Link to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className="btn btn--primary"><Plus size={16} aria-hidden /> {t("entityRecord.cert.missingAction")}</Link>}
        {open && attaching && first && <AttachHost entityId={e.id} workplaceId={first.id} onClose={() => setAttaching(false)} />}
      </div>
    </section>
  );
}
