import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { reasonCodesQuery, useReasonCodesReady } from "../../../lib/reason-codes";
import { unitsQuery } from "../../../reference/org/api";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { withinEntity } from "../../../reference/entity/domain/placement";
import { Button, IconButton, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/kbd/kbd";
import { Receipt } from "../../../ui/receipt/receipt";
import { StepLine } from "../../../ui/step-line/step-line";
import { Banner } from "../../../ui/banner/banner";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { groupRows, whenOf, type Kind } from "../domain/bulk";
import { activeTitles, DEMOTION_REASON } from "../domain/titles";
import { bulkDemotion, bulkPromotion } from "../domain/bulk-promotion";
import { jobTitlesQuery } from "../api";
import { BulkPeople } from "./bulk-people";
import { BulkRescind } from "./bulk-rescind";
import { BulkWhen, type HeadRow } from "./bulk-when";
import { BulkWhere } from "./bulk-where";
import { useBulkCommand } from "./use-bulk-command";
import { useBulkRows } from "./use-bulk-rows";
import { bulkSelection, useBulkSelection } from "./use-bulk-selection";
import s from "./bulk-page.module.css";
import { entityName } from "../../../reference/entity/domain/names";

/**
 * The bulk act workspace (spec E6-move): the people picked in the roster, where they go (a tree of places that can take all of
 * them) or the new title, when and why, what each unit's headcount becomes, and one commit for everyone (BW-38 change
 * set: all or nothing, one batch to cancel). Steps across the head say how far it is.
 */
export function BulkPage() {
  const nav = useNavigate();
  const picked = useBulkSelection();
  const today = todayKst();
  const units = useQuery(unitsQuery).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const structure = useQuery(orgStructureRef);
  const roots = structure.data?.entities ?? [];
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const [kind, setKind] = useState<Kind | null>(null);
  const [unitId, setUnit] = useState("");
  const [position, setPosition] = useState("");
  const [date, setDate] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [memo, setMemo] = useState("");
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ id: string; count: number } | null>(null);
  // Every reason list this page can show is read up front, so a field opens complete on the click that shows it
  // (a list landing later would push the memo under the pointer): both kinds' reasons, and the rescind sheet's.
  const titlesQ = useQuery(jobTitlesQuery);
  const listsReady = [useQuery(reasonCodesQuery("lifecycle_transfer")), useQuery(reasonCodesQuery("lifecycle_promote")), titlesQ].every((q) => !q.isPending);
  useQuery({ ...reasonCodesQuery("lifecycle_cancel"), enabled: batch != null });
  const [rescinding, setRescinding] = useState(false);
  // A promotion's per-person title (spec E6-promote): picked or a suggestion accepted; else the one for everyone.
  const [perRow, setPerRow] = useState<Record<string, string>>({});
  const titles = activeTitles(titlesQ.data?.items ?? [], "TITLE");
  // With a title list each person's promotion is picked on their row; the one-for-everyone field only fills the rest.
  const perPerson = kind === "PROMOTE" && titles.length > 0;
  const sheet = { unitId: unitId || undefined, position: position.trim() || undefined };
  const resolvedRows = useBulkRows({ picked }, kind, sheet, {});
  // The picked records and lists arrive before a kind opens, so their context cannot move its controls.
  const kindsReady = listsReady && resolvedRows.ready && structure.isSuccess;
  const resolved = { ...resolvedRows, rows: resolvedRows.rows.map((r) => (kind === "PROMOTE" && perRow[r.key] ? { ...r, target: perRow[r.key]! } : r)) };
  const cmd = useBulkCommand((rs) => (setBatch({ id: rs[0]!.batchId, count: rs[0]!.count }), setDone(t("bulk.page.done", { n: rs[0]!.count, kind: label(LIFECYCLE_EVENT, kind!), state: t(rs[0]!.scheduled ? "bulk.page.doneFuture" : "bulk.page.doneNow"), date: fmtDate(date) }))));
  const rows = resolved.rows.filter((r) => !(r.employee && cmd.recordedIds.has(r.employee.id)));
  const ok = rows.filter((r) => !r.problem);
  const employers = new Set(ok.map((r) => r.employee?.legal_entity_id).filter(Boolean));
  const targets = units.filter((u) => u.kind === "COMPANY" || [...employers].every((id) => withinEntity(roots, u.id, id)));
  const promotionGroups = groupRows(ok, "PROMOTE", sheet);
  const demotion = kind === "PROMOTE" && promotionGroups.some((g) => g.rows.some((r) => bulkDemotion(r.employee?.position, g.target, titlesQ.data?.items ?? [])));
  const invalidTitle = kind === "PROMOTE" && promotionGroups.some((g) => !bulkPromotion(g.target, titles));
  const when = whenOf(date, today);
  const codes = useReasonCodesReady(kind === "TRANSFER" ? "lifecycle_transfer" : kind === "PROMOTE" ? "lifecycle_promote" : null);
  // Cmd/Ctrl+Enter commits from anywhere on the page (spec section 3).
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && document.getElementById("bulk-commit")?.click();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  if (picked.size === 0 && !done)
    return <div className="page"><EmptyState title={t("bulk.page.empty.title")} reason={t("bulk.page.empty.reason")} actions={<Link className={buttonClass("primary")} to="/people" search={{}}>{t("bulk.page.empty.action")}</Link>} /></div>;

  const from = new Map<string, number>();
  for (const r of ok) if (r.employee?.org_unit_id) from.set(r.employee.org_unit_id, (from.get(r.employee.org_unit_id) ?? 0) + 1);
  const siteOf = (id: string | null | undefined) => {
    let u = units.find((x) => x.id === id);
    while (u && u.kind !== "SITE") u = units.find((x) => x.id === u!.parentId);
    return u?.name;
  };
  const sites = new Set(ok.map((r) => siteOf(r.employee?.org_unit_id)));
  const site = sites.size === 1 ? [...sites][0] : undefined;
  const toSite = siteOf(unitId);
  const entityId = ok.find((r) => r.employee?.legal_entity_id)?.employee?.legal_entity_id;
  const entity = entityName(entities.find((e) => e.id === entityId) ?? entities[0]);
  const heads: HeadRow[] = kind === "TRANSFER" && unitId ? [...from].flatMap(([id, n]) => units.filter((u) => u.id === id).map((u) => ({ id, name: u.name, before: u.headcount, after: u.headcount - n }))) : [];
  const target = units.find((u) => u.id === unitId);
  if (kind === "TRANSFER" && target) heads.push({ id: target.id, name: target.name, before: target.headcount, after: target.headcount + ok.length });
  if (kind === "TRANSFER" && target && site) heads.push({ id: "site", name: site, note: t(toSite === site ? "bulk.page.siteRow" : "bulk.page.siteMove") });

  const missing = {
    kind: !kind ? t("bulk.kind.missing") : undefined,
    unit: kind === "TRANSFER" && !unitId ? t("bulk.unit.missing") : undefined,
    position: kind === "PROMOTE" && ok.some((r) => !(perRow[r.key] || position.trim())) ? (perPerson ? t("bulk.position.missingPer", { n: ok.filter((r) => !(perRow[r.key] || position.trim())).length }) : t("bulk.position.missing")) : undefined,
    date: when === "none" ? t("bulk.date.missing") : undefined,
    catalog: invalidTitle ? t("bulk.position.catalogMissing") : undefined,
    code: codes && (!code || (demotion && code !== DEMOTION_REASON)) ? t(demotion ? "lifecycle.promote.demotionMissing" : "reason.field.missing") : undefined,
    memo: !memo.trim() ? t("bulk.reason.missing") : undefined,
  };
  const gaps = Object.values(missing).filter(Boolean).length;
  const shown = (m?: string) => (tried ? m : undefined);
  const batches = (rs: typeof ok) =>
    groupRows(rs, kind!, sheet).map((g) => ({ event_type: kind!, employee_ids: g.rows.map((r) => r.employee!.id), to_org_unit_id: kind === "TRANSFER" ? g.target : undefined, ...(kind === "PROMOTE" ? bulkPromotion(g.target, titles) : {}), effective_date: date, reason_code: code ?? undefined, comment: memo.trim() }));
  const submit = () => {
    setTried(true);
    if (gaps || rows.some((r) => r.problem) || ok.length === 0 || !resolved.ready || cmd.busy) return;
    void cmd.send(batches(ok));
  };
  // The refused people leave the batch and the rest is sent again (one press, spec E12-partial's way out).
  const refusedIds = ok.filter((r) => r.employee && cmd.refused.has(r.employee.id)).map((r) => r.employee!.id);
  const retryWithout = () => {
    refusedIds.forEach((id) => bulkSelection.drop(id));
    void cmd.send(batches(ok.filter((r) => !refusedIds.includes(r.employee!.id))));
  };
  const kindWord = kind ? label(LIFECYCLE_EVENT, kind) : "";
  const fromName = from.size === 1 ? units.find((u) => u.id === [...from.keys()][0])?.name ?? "" : t("bulk.target.pasted.TRANSFER");
  const toName = kind === "PROMOTE" ? (titles.find((x) => x.id === position)?.label ?? position.trim()) : (target?.name ?? "");
  const whereDone = Boolean(kind && (unitId || position.trim() || (kind === "PROMOTE" && ok.length > 0 && ok.every((r) => perRow[r.key]))) && when !== "none");
  const steps = [
    { key: "people", label: t("bulk.page.step.people"), state: "done" as const },
    { key: "where", label: t("bulk.page.step.where"), state: whereDone ? ("done" as const) : ("current" as const) },
    { key: "check", label: t("bulk.page.step.check"), state: done ? ("done" as const) : whereDone ? ("current" as const) : ("waiting" as const) },
    { key: "commit", label: t(when === "future" ? "bulk.page.step.schedule" : "bulk.page.step.apply"), state: done ? ("current" as const) : ("waiting" as const) },
  ];
  const commit = !kind ? t("bulk.page.commit.none", { n: ok.length, kind: t("bulk.title") }) : t(`bulk.page.commit.${when === "future" ? "future" : when === "past" ? "past" : when === "today" ? "now" : "none"}`, { n: ok.length, kind: kindWord, date: date.slice(5) });
  return (
    <div className={s.page}>
      <PageHead
        band
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("bulk.page.crumb")} />}
        title={kind ? t("bulk.page.title", { kind: kindWord, n: ok.length }) : t("bulk.page.titleNone", { n: ok.length })}
        meta={<PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "bulk.page.phaseSetup" : "bulk.page.phaseOp")}</PhaseLine>}
        tools={<><StepLine steps={steps} label={t("bulk.page.steps")} /><IconButton label={t("bulk.page.close")} onClick={() => void nav({ to: "/people", search: {} })}><X size={16} aria-hidden /></IconButton></>}
      />
      <div role="group" aria-label={t("bulk.page.kind")} className={s.kinds} data-invalid={shown(missing.kind) ? true : undefined}>
        {(["TRANSFER", "PROMOTE"] as const).map((k) => <ToggleButton key={k} pressed={kind === k} disabled={!kindsReady} aria-busy={!kindsReady || undefined} onClick={() => (setKind(k), setCode(null))}>{label(LIFECYCLE_EVENT, k)}</ToggleButton>)}
        {shown(missing.kind) && <span className={s.err}>{missing.kind}</span>}
      </div>
      <div className={s.cols}>
        <BulkWhere kind={kind} titles={titles} units={targets} from={from.size === 1 ? new Set(from.keys()) : new Set()} site={site} entity={entity} hidden={Math.max(0, entities.length - 1)} unitId={unitId} onUnit={setUnit} position={position} onPosition={setPosition} count={ok.length} unitError={shown(missing.unit)} positionError={perPerson ? undefined : shown(missing.catalog ?? missing.position)} positionOptional={perPerson} />
        <BulkPeople kind={kind} rows={rows} pending={resolved.ready ? 0 : picked.size} units={units} unitId={unitId} position={position} titles={titles} perRow={perRow} onPerRow={(k, v) => setPerRow((x) => ({ ...x, [k]: v }))} sub={site ? t(toSite && toSite !== site ? "bulk.page.peopleSub.move" : "bulk.page.peopleSub.same", { site, from: site, to: toSite ?? "" }) : ""} onDrop={(k) => bulkSelection.drop(k)} foot={t("bulk.page.recheck", { total: ok.length })} refused={cmd.refused} error={perPerson ? shown(missing.catalog ?? missing.position) : undefined} />
        <BulkWhen demotion={demotion} kind={kind} today={today} date={date} onDate={setDate} code={code} onCode={setCode} memo={memo} onMemo={setMemo} shown={{ date: shown(missing.date), code: shown(missing.code), memo: shown(missing.memo) }} tried={tried} heads={heads} echo={when === "future" ? t("lifecycle.when.future") : when === "none" ? undefined : t("lifecycle.when.today")} />
      </div>
      <footer className={s.bar}>
        <div className={s.barText}>
          {refusedIds.length > 0 && (
            <Banner tone="danger" live="assertive" title={t("bulk.refused.title", { count: refusedIds.length })} actions={<Button onClick={retryWithout} disabled={cmd.busy}>{t("bulk.retryWithout", { count: refusedIds.length })}</Button>} />
          )}
          {done ? <Receipt state="recorded" message={done} actions={batch && <><Link className={buttonClass()} to="/people/notices/new" search={{ batch: batch.id, count: batch.count }}>{t("bulk.notice.open")}</Link><Button variant="ghost" onClick={() => setRescinding(true)}>{t("bulk.rescind.open", { count: batch.count })}</Button></>} />
          : whereDone ? <><b>{t("bulk.page.foot", { n: ok.length, from: kind === "PROMOTE" ? "" : fromName, to: toName, date, state: t(when === "future" ? "bulk.page.footState.future" : "bulk.page.footState.now") })}</b></>
          : <span>{t("bulk.page.footNone", { n: ok.length })}</span>}
          <CommandError error={cmd.error} />
        </div>
        <Button variant="ghost" onClick={() => void nav({ to: "/people", search: {} })}>{t("bulk.page.back")}</Button>
        {!done && <Button id="bulk-commit" variant="primary" aria-disabled={cmd.busy || undefined} onClick={submit}>{commit}<Kbd keys="⌘↵" /></Button>}
      </footer>
      {rescinding && batch && <BulkRescind batchId={batch.id} count={batch.count} onClose={() => setRescinding(false)} onDone={(n) => (setRescinding(false), setBatch(null), setDone(t("bulk.rescind.done", { count: n })))} />}
    </div>
  );
}
