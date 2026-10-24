import { verificationState } from "../present-verification";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Building2, ChevronRight, Network, PencilLine, Plus } from "lucide-react";
import type { LegalEntity, OrgStructureNode } from "@console/api/pending";
import { t } from "@console/i18n";
import { BIZ_KIND, label } from "../../../lib/labels";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { QueryState } from "../../../lib/react/query-state";
import { checklistRef, orgStructureAt } from "../../../reference/entity/api";
import { todayKst } from "../../../lib/pure/today";
import { entityGone } from "../domain/gone";
import { EntityGone } from "./entity-error";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { entityDocumentsQuery, entityEndQuery, entityHistoryQuery, entityQuery } from "../api";
import { primaryRegistration } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { unattached } from "../domain/attach";
import { LockNotice } from "./record-lock";
import { lockOf, RecordLockProvider, useRecordLock } from "./use-record-lock";
import { AttachHost } from "./workplace-attach-sheet";
import { FoundingCard } from "./record-founding";
import { DocumentsTab } from "./documents-tab";
import { HistoryTab } from "./history-tab";
import { VoidEntity } from "./void-entity";
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

const TABS = ["overview", "certificates", "workplaces", "officers", "documents", "history"] as const;
type Tab = (typeof TABS)[number];

const countDepts = (n: OrgStructureNode | undefined): number => (n ? n.children.reduce((a, x) => a + (x.kind === "DEPARTMENT" ? 1 : 0) + countDepts(x), 0) : 0);

/**
 * One entity as its record (spec S3): the certificate's items in their printed numbers, registry and entity basics, its workplace
 * and certificates, VAT and worker facts, and beside them where it stands, its history, how it closes and its
 * kept originals. Every fact carries one verb: edit (change (REV) or correction (COR)), correct-only, or an identifier's correction.
 */
export function EntityRecord({ id, workplace, initialTab }: { id: string; workplace?: string; initialTab?: "history" }) {
  const { as_of, known_at, reissue, nts } = route.useSearch();
  const navigate = route.useNavigate();
  const point = { as_of, known_at };
  const today = todayKst();
  const temporal = Boolean(known_at) || Boolean(as_of && as_of !== today);
  const read = entityQuery(id, point);
  // A legal entity a command changed since it was cached (a workplace sheet's save) is drawn only once re-read: drawn stale, its
  // facts moved under the next click when the re-read landed.
  const q = useFreshOnArrival(useQuery(read), read);
  const docsQ = useQuery({ ...entityDocumentsQuery(id), retry: false });
  const historyRead = entityHistoryQuery(id);
  const hist = useFreshOnArrival(useQuery({ ...historyRead, retry: false }), historyRead);
  const end = useQuery({ ...entityEndQuery(id), retry: false });
  const phaseQ = useQuery(checklistRef);
  const phase = phaseQ.data?.phase;
  const structure = useQuery(orgStructureAt(point));
  const node = structure.data?.entities.find((n) => n.id === id);
  const [tab, setTab] = useState<Tab>(nts ? "certificates" : initialTab ?? (workplace ? "workplaces" : "overview"));
  useEffect(() => {
    if (nts && tab === "certificates" && q.isSuccess) requestAnimationFrame(() => document.getElementById(`nts-${nts}`)?.scrollIntoView({ block: "center" }));
  }, [nts, tab, q.isSuccess]);
  const [selectedWorkplace, setSelectedWorkplace] = useState(workplace);
  if (selectedWorkplace !== workplace) {
    setSelectedWorkplace(workplace);
    if (workplace) setTab("workplaces");
  }
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
  const title = (e: LegalEntity) => <h1 className="page__title" tabIndex={-1}><EntityName entity={e} /></h1>;
  const head = (e: LegalEntity) => {
    const primary = primaryRegistration(e);
    const lock = temporal ? "asof" : lockOf(e);
    const v = primary ? verificationState(primary) : null;
    return (
      <div className={s.head}>
        <nav className={s.crumb} aria-label={t("entityRecord.crumb")}><Network size={14} aria-hidden /><Link to="/org" search={point}>{t("entityRecord.crumbRoot")}</Link><ChevronRight size={14} aria-hidden /><span>{entityName(e)}</span></nav>
        <div className={s.titleRow}>
          <Building2 size={22} aria-hidden className={s.titleIcon} />
          {title(e)}
          {e.biz_kind && <Chip tone="neutral">{label(BIZ_KIND, e.biz_kind)}</Chip>}
          {/* company-05: an entity being founded reads as founding alone, never "continuing" beside it. */}
          {e.founding ? <Chip tone="info">{t("entityOps.founding.chip")}</Chip> : <Chip tone={e.closed_on ? "neutral" : "ok"}>{t(e.closed_on ? "entityRecord.status.closed" : "entityRecord.status.open")}</Chip>}
          {!e.closed_on && primary?.current?.status === "SUSPENDED" && <Chip tone="warn">{t("enum.recordStatus.SUSPENDED")}</Chip>}
          {v && <Chip tone="neutral">{v.label}</Chip>}
          <div className="grow" />
          <Link to="/org" search={point} className="btn"><Network size={16} aria-hidden /> {t("entityRecord.action.chart")}</Link>
          {!lock && <Link to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className="btn"><Plus size={16} aria-hidden /> {t("entityRecord.action.addWorkplace")}</Link>}
          {!lock && <Button variant="primary" onClick={() => setTab("certificates")}><PencilLine size={16} aria-hidden /> {t("entityRecord.action.editByCert")}</Button>}
        </div>
        <div className={s.nameProblems}><NameProblems e={e} onCertificate={() => setTab("certificates")} review={(r) => <NameReview key={r.id} e={e} review={r} editable={e.can_manage && !lock} />} /></div>
        <LockNotice e={e} lock={lock} />
        <div role="group" aria-label={t("entityRecord.tabs")} className={s.tabs}>
          {TABS.filter((x) => x !== "documents" || !docsQ.isError).map((x) => (
            <ToggleButton key={x} pressed={tab === x} onClick={() => setTab(x)}>
              {t(`entityRecord.tab.${x}`)}{" "}
              {x !== "overview" && <span className={s.count}>{x === "certificates" ? e.registrations.length : x === "workplaces" ? e.workplaces.length : x === "officers" ? (e.current?.representatives?.length ?? 0) + (e.current?.directors?.length ?? 0) : x === "documents" ? (docsQ.data?.items.length ?? 0) : (hist.data?.items.length ?? "")}</span>}
            </ToggleButton>
          ))}
        </div>
      </div>
    );
  };
  // The phase decides each identifier's verb and how the record closes: the page waits for it, so nothing moves.
  if (q.error && entityGone(q.error)) return <>{band}<EntityGone error={q.error} wasShown={q.data !== undefined} /></>;
  if (phaseQ.isPending || hist.isPending || end.isPending || docsQ.isPending || structure.isPending) return <>{band}{q.data && <div className={s.head}>{title(q.data)}</div>}<p className="muted" role="status">{t("common.loading")}</p></>;
  return (
    <>{band}<QueryState q={sheet && displayed ? { ...q, data: displayed } : q}>
      {(e) => {
        const readOnly = temporal || Boolean(e.read_only);
        const act: Act = {
          field: <V,>(spec: FieldSpec<V>) => { if (!readOnly) setSheet(<ReviseSheet e={e} spec={spec} phase={phase} onClose={close} />); },
          identifier: (field, registrationId) => { if (!readOnly) setSheet(<IdentifierSheet e={e} field={field} registrationId={registrationId ?? primaryRegistration(e)?.id} operating={operating} onClose={close} />); },
          reissue: (registrationId) => void navigate({ search: (search) => ({ ...search, reissue: registrationId }) }),
          close: () => { if (!readOnly) setSheet(<CloseSheet e={e} depts={depts} onClose={close} />); },
          remove: () => { if (!readOnly) setSheet(<VoidEntity e={e} onClose={close} />); },
        };
        const primary = primaryRegistration(e);
        const docs = docsQ.isSuccess ? docsQ.data.items : null;
        const reissuing = reissue ? e.registrations.find((r) => r.id === reissue && !r.closed_on) : undefined;
        return (
          <RecordLockProvider key={`${id}:${as_of ?? ""}:${known_at ?? ""}`} value={readOnly ? "asof" : lockOf(e)}>
          <div className={s.page}>
            {head(e)}
            <div className={s.body}>
              {tab === "overview" && (
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
              {tab === "certificates" && (
                <div className={s.wide}>
                  {e.registrations.map((r) => <CertCard showCheck key={r.id} e={e} r={r} act={act} operating={operating} onOriginal={docs?.length ? () => setTab("documents") : undefined} />)}
                  {e.registrations.length === 0 && <NoCertificate e={e} />}
                </div>
              )}
              {tab === "workplaces" && <div className={s.wide}><WorkplacesTab e={e} selected={workplace} /></div>}
              {tab === "officers" && <div className={s.wide}><OfficersTab e={e} act={act} /></div>}
              {tab === "documents" && <div className={s.wide}><DocumentsTab docs={docs ?? []} /></div>}
              {tab === "history" && <div className={s.wide}><HistoryTab e={e} /></div>}
            </div>
            {!readOnly && <CorrectionRegister entityId={e.id} />}
            {!readOnly && sheet}
            {!readOnly && reissuing && <ReissueSheet e={e} r={reissuing} phase={phase} onClose={() => void navigate({ search: (search) => ({ ...search, reissue: undefined }), replace: true })} />}
          </div>
          </RecordLockProvider>
        );
      }}
    </QueryState></>
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
