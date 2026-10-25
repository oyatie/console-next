import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce, focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { TENANT_STATUS, TENANT_LIFECYCLE, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Button, Form, ToggleButton } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import { opsQuery, tenantsQuery, type Health, type Issued, type Org, type Recorded } from "../api";
import { VIEWS, inView, matches, type View } from "../domain/tenants";
import { CodeDialog } from "./code-dialog";
import { OnboardDialog } from "./onboard-form";
import { SupportLookup } from "../../../lib/react/support-lookup";
import { TenantPanel } from "./tenant-panel";
import { KeyNotices } from "./key-notices";

/** The URL holds what a support ticket links to: the tenant, the search and the view. */
export type TenantsSearch = { sel?: string; q?: string; view?: Exclude<View, "active"> };

const route = getRouteApi("/app/platform");

/** Vendor tier: every tenant, a panel per tenant for its lifecycle, and onboarding with a one-time first-admin code. */
export function TenantsPage() {
  const { sel, q: q0 = "", view = "active" } = route.useSearch();
  const navigate = route.useNavigate();
  const set = (s: TenantsSearch) => navigate({ search: (p) => ({ ...p, ...s }), replace: true });
  const list = useQuery({ ...tenantsQuery, refetchOnMount: "always" });
  const ops = useQuery(opsQuery);
  const health = new Map<string, Health>((ops.data?.tenants ?? []).map((h) => [h.id, h]));
  // Typed text stays local (no lag while composing Korean); the URL follows it once typing pauses, and
  // a navigation that changes the URL's search (a link, Back) replaces it.
  const [q, setQ] = useState(q0);
  const pushed = useRef(q0);
  useEffect(() => {
    if (q0 === pushed.current) return;
    pushed.current = q0;
    setQ(q0);
  }, [q0]);
  const [onboarding, setOnboarding] = useState(false);
  const [issued, setIssued] = useState<Issued & { onboarded?: { id: string; slug: string } } | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const all = (list.data ?? []).filter((o) => o.slug !== "platform");
  const found = all.filter((o) => matches(o, q));
  const rows = found.filter((o) => inView(o, view));
  const selected = all.find((o) => o.id === sel);


  const record = (r: Recorded) => {
    setRecorded(r);
    focusSoon("tenants-receipt");
  };
  // The match count is spoken once typing pauses, not on every keystroke.
  const matched = found.length;
  useEffect(() => {
    const id = setTimeout(() => {
      if (q !== pushed.current) {
        pushed.current = q;
        void navigate({ search: (p) => ({ ...p, q: q || undefined }), replace: true });
      }
      if (q.trim()) announce(t("tenants.search.count", { count: matched }));
    }, 500);
    return () => clearTimeout(id);
  }, [q, matched, navigate]);
  const toFirstMatch = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    document.querySelector<HTMLElement>("#tenants-list tbody tr")?.focus();
  };
  const closeCode = () => {
    if (!issued) return;
    const { org, onboarded, expiresAt } = issued;
    setIssued(null);
    if (onboarded) void set({ sel: onboarded.id });
    record(onboarded ? { message: t("tenants.onboard.done", { org }), meta: t("tenants.onboard.meta", { slug: onboarded.slug }) } : { message: t("tenants.reissue.done", { org }), meta: t("common.expiresAt", { at: fmtDateTime(expiresAt) }) });
  };
  const empty = list.isSuccess && all.length === 0;

  return (
    <div className="page">
      <h1 id="tenants-title" className="page__title" tabIndex={-1}>{t("tenants.title")}</h1>
      <PageReadGate q={list}>
      <div className="page__head">
        {!empty && (
          <div role="group" aria-label={t("tenants.views")} className="tabs">
            {VIEWS.map((v) => (
              <ToggleButton key={v} pressed={view === v} onClick={() => set({ view: v === "active" ? undefined : v })}>
                {t(`tenants.view.${v}`, { n: all.filter((o) => inView(o, v)).length })}
              </ToggleButton>
            ))}
          </div>
        )}
        <span className="top__spacer" />
        {!empty && (
          <Form role="search" className="search" onSubmit={() => undefined}>
            <Field label={t("tenants.search")} required={null}>{p => <TextInput {...p}
              placeholder={t("tenants.search.example")}
              value={q}
              onKeyDown={toFirstMatch}
              onChange={(e) => setQ(e.target.value)}
            />}</Field>
          </Form>
        )}
        {list.data && !empty && <Button variant="primary" onClick={() => setOnboarding(true)}><Plus size={16} aria-hidden /> {t("tenants.create")}</Button>}
      </div>
      <QueryState q={list} layout="list">{() => <>
      <SupportLookup />
      <KeyNotices notices={[...(ops.data?.notices ?? []), ...(ops.data?.registration_check_notices ?? [])]} />
      {recorded && (
        <div id="tenants-receipt" tabIndex={-1}>
          <Receipt state="recorded" message={recorded.message} meta={recorded.meta} />
        </div>
      )}
      <div className="split" data-open={Boolean(selected)}>
        <section id="tenants-list" className="card" aria-label={t("tenants.table")}>
          {empty ? (
                <EmptyState title={t("tenants.empty.title")} reason={t("tenants.empty.reason")} actions={<Button variant="primary" onClick={() => setOnboarding(true)}><Plus size={16} aria-hidden /> {t("tenants.create")}</Button>} />
              ) : found.length === 0 ? (
                <EmptyState title={t("tenants.search.none", { q: q.trim() })} reason={t("tenants.search.noneReason")} actions={<Button onClick={() => setQ("")}>{t("tenants.search.reset")}</Button>} />
              ) : rows.length === 0 ? (
                <EmptyState title={t("tenants.view.empty")} reason={t("tenants.view.emptyReason")} actions={<Button onClick={() => set({ view: "all" })}>{t("tenants.view.showAll")}</Button>} />
              ) : (
              <>
                {ops.isError && <QueryState q={ops} own={() => t("tenants.opsFailed")}>{() => null}</QueryState>}
                <Table
                  label={t("tenants.table")}
                  rows={rows}
                  rowId={(o: Org) => o.id}
                  selected={sel}
                  onSelect={(id) => set({ sel: id })}
                  columns={[
                    { header: t("tenants.col.name"), cell: (o) => <span title={o.name}>{o.name}</span> },
                    { header: t("tenants.col.slug"), width: "code", cell: (o) => <span className="code">{o.slug}</span>, fit: true },
                    { header: t("tenants.col.status"), width: "status", cell: (o) => { const s = labeled(TENANT_STATUS, o.status); return <><Chip tone={s.tone}>{s.label}</Chip>{" "}{o.lifecycle && <Chip tone={labeled(TENANT_LIFECYCLE, o.lifecycle).tone}>{labeled(TENANT_LIFECYCLE, o.lifecycle).label}</Chip>}</>; }, fit: true },
                    { header: t("tenants.col.users"), width: "summary", cell: (o) => { return <span className="num">{o.passkey_registered_count !== undefined ? t("tenants.accounts.states", { issued: o.code_issued_count ?? 0, registered: o.passkey_registered_count }) : "—"}</span>; }, fit: true },
                    { header: t("tenants.col.activity"), width: "datetime", cell: (o) => <span className="num">{fmtDateTime(health.get(o.id)?.last_activity_at)}</span>, fit: true, wide: true },
                    { header: t("tenants.col.created"), width: "datetime", cell: (o) => <span className="num">{fmtDateTime(o.created_at)}</span>, fit: true },
                  ]}
                />
              </>
            )}
        </section>
        {selected && (
          <TenantPanel
            key={selected.id}
            org={selected}
            health={health.get(selected.id)}
            onIssued={setIssued}
            onRecorded={record}
            onRemoved={(r) => {
              void set({ sel: undefined });
              setRecorded(r);
              focusSoon("tenants-receipt", "tenants-title");
            }}
            onClose={() => set({ sel: undefined })}
          />
        )}
      </div>
      <OnboardDialog
        open={onboarding}
        existing={list.data ?? []}
        onClose={() => setOnboarding(false)}
        onIssued={(r) => {
          setOnboarding(false);
          setIssued(r);
        }}
        onLost={(o) => {
          setOnboarding(false);
          void set({ sel: o.id });
          record({ message: t("tenants.form.lost", { org: o.name }), meta: t("tenants.onboard.meta", { slug: o.slug }) });
        }}
      />
      <CodeDialog issued={issued} onClose={closeCode} />
    </>}</QueryState>
      </PageReadGate>
    </div>
  );
}
