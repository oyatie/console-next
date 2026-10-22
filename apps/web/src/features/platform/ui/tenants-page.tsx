import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce, focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { TENANT_STATUS, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Button, Form, ToggleButton } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { TextInput } from "../../../ui/field/field";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import { opsQuery, tenantsQuery, type Health, type Issued, type Org, type Recorded } from "../api";
import { VIEWS, inView, matches, type View } from "../domain/tenants";
import { CodeDialog } from "./code-dialog";
import { OnboardDialog } from "./onboard-form";
import { SupportLookup } from "../../../lib/react/support-lookup";
import { TenantPanel } from "./tenant-panel";
import css from "./tenants.module.css";

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
  // Reissue is refused for good once the admin enrolls a passkey; remembered for this session.
  const [enrolled, setEnrolled] = useState<ReadonlySet<string>>(new Set());
  const all = (list.data ?? []).filter((o) => o.slug !== "platform");
  const found = all.filter((o) => matches(o, q));
  const rows = found.filter((o) => inView(o, view));
  const selected = all.find((o) => o.id === sel);
  // The panel's column is always there once there are tenants (a hint until one is chosen): the table's columns would
  // otherwise re-flow under the pointer whenever the panel comes or goes, including while a chosen tenant is read.
  const reserved = Boolean(sel) && !selected && (list.isPending || list.isFetching);

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
      <div className="page__head">
        <h1 id="tenants-title" className="page__title" tabIndex={-1}>{t("tenants.title")}</h1>
        {!empty && (
          <div role="group" aria-label={t("tenants.views")} className="tabs">
            {VIEWS.map((v) => (
              <ToggleButton key={v} pressed={view === v} onClick={() => set({ view: v === "active" ? undefined : v })}>
                {t(`tenants.view.${v}`, { n: found.filter((o) => inView(o, v)).length })}
              </ToggleButton>
            ))}
          </div>
        )}
        <span className="top__spacer" />
        {!empty && (
          <Form role="search" className="search" onSubmit={() => undefined}>
            <TextInput
              aria-label={t("tenants.search")}
              placeholder={t("tenants.search.example")}
              value={q}
              onKeyDown={toFirstMatch}
              onChange={(e) => setQ(e.target.value)}
            />
          </Form>
        )}
        {!empty && <Button variant="primary" onClick={() => setOnboarding(true)}><Plus size={16} aria-hidden /> {t("tenants.create")}</Button>}
      </div>
      <SupportLookup />
      {recorded && (
        <div id="tenants-receipt" tabIndex={-1}>
          <Receipt state="recorded" message={recorded.message} meta={recorded.meta} />
        </div>
      )}
      <div className="split" data-open={!empty}>
        <section id="tenants-list" className={`card ${css.list}`} aria-label={t("tenants.table")}>
          <QueryState
            // Held until the health read lands too (or fails): its users and activity columns would otherwise
            // fill in late and re-flow every column under the pointer.
            q={ops.isPending ? { ...list, isPending: true } : list}
            empty={() =>
              empty ? (
                <EmptyState title={t("tenants.empty.title")} reason={t("tenants.empty.reason")} actions={<Button variant="primary" onClick={() => setOnboarding(true)}><Plus size={16} aria-hidden /> {t("tenants.create")}</Button>} />
              ) : found.length === 0 ? (
                <EmptyState title={t("tenants.search.none", { q: q.trim() })} reason={t("tenants.search.noneReason")} />
              ) : rows.length === 0 ? (
                <EmptyState title={t("tenants.view.empty")} reason={t("tenants.view.emptyReason")} actions={<Button onClick={() => set({ view: "all" })}>{t("tenants.view.showAll")}</Button>} />
              ) : null
            }
          >
            {() => (
              <>
                {ops.isError && <p className="toolbar muted">{t("tenants.opsFailed")}</p>}
                <Table
                  label={t("tenants.table")}
                  rows={rows}
                  rowId={(o: Org) => o.id}
                  selected={sel}
                  onSelect={(id) => set({ sel: id })}
                  columns={[
                    { header: t("tenants.col.name"), cell: (o) => <span title={o.name}>{o.name}</span> },
                    { header: t("tenants.col.slug"), cell: (o) => <span className="code">{o.slug}</span>, fit: true },
                    { header: t("tenants.col.group"), cell: (o) => <span title={o.group_name ?? undefined}>{o.group_name ?? "—"}</span>, wide: true },
                    { header: t("tenants.col.status"), cell: (o) => { const s = labeled(TENANT_STATUS, o.status); return <Chip tone={s.tone}>{s.label}</Chip>; }, fit: true },
                    { header: t("tenants.col.users"), cell: (o) => { const h = health.get(o.id); return <span className="num">{h ? t("tenants.users.ratio", { active: h.active_user_count, total: h.user_count }) : "—"}</span>; }, fit: true },
                    { header: t("tenants.col.activity"), cell: (o) => <span className="num">{fmtDateTime(health.get(o.id)?.last_activity_at)}</span>, fit: true, wide: true },
                    { header: t("tenants.col.created"), cell: (o) => <span className="num">{fmtDateTime(o.created_at)}</span>, fit: true },
                  ]}
                />
              </>
            )}
          </QueryState>
        </section>
        {!selected && !empty && (
          <aside className="card panel" aria-busy={reserved || undefined}>
            <span className="muted" role="status">{reserved ? t("common.loading") : t("tenants.panel.none")}</span>
          </aside>
        )}
        {selected && (
          <TenantPanel
            key={selected.id}
            org={selected}
            health={health.get(selected.id)}
            enrolled={enrolled.has(selected.id)}
            onEnrolled={() => setEnrolled((s) => new Set(s).add(selected.id))}
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
    </div>
  );
}
