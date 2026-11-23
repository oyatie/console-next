// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { SUPPORT_SESSION_STATE, codeText, label } from "../../../lib/labels";
import { SupportLookup } from "../../../lib/react/support-lookup";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { EnumValue } from "../../../ui/enum-value";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { rowById } from "../../../ui/long-table/row-keys";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import {
  operatorId,
  supportSessionsQuery,
  tenantsQuery,
  type Recorded,
  type SupportSessionMetadata,
  type SupportStartOutcome,
} from "../api";
import { SupportSessionPanel } from "./support-console-panel";
import { RequestSupportDialog, SupportTokenDialog } from "./support-request-dialog";
import { useDesktopAutoSelect } from "./use-desktop-auto-select";
import s from "./platform-console.module.css";

type SupportStateFilter = "all" | "REQUESTED" | "OPERATOR_APPROVED" | "ACTIVE";
const scopeText = (scope: string) => codeText(`accessCodes.domain.${scope}`, scope);

export function SupportConsole({
  tabs,
  initialOrgId,
}: {
  tabs: ReactNode;
  initialOrgId?: string;
}) {
  const orgsQ = useQuery(tenantsQuery);
  const activeOrgs = useMemo(
    () => (orgsQ.data ?? []).filter((o) => o.slug !== "platform" && o.status === "ACTIVE"),
    [orgsQ.data],
  );
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const effectiveOrg =
    activeOrgs.find((o) => o.id === (selectedOrgId ?? initialOrgId ?? null)) ?? activeOrgs[0];

  const sessionsQ = useQuery({
    ...supportSessionsQuery(effectiveOrg?.id ?? ""),
    enabled: Boolean(effectiveOrg?.id),
  });
  const listState = effectiveOrg ? sessionsQ : orgsQ;

  const [selectedId, setSelectedId] = useState<string>();
  const [stateFilter, setStateFilter] = useState<SupportStateFilter>("all");
  const [q, setQ] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [startedToken, setStartedToken] = useState<SupportStartOutcome | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [full, setFull] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const sessions = useMemo(() => sessionsQ.data?.sessions ?? [], [sessionsQ.data]);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return sessions.filter((item) => {
      if (stateFilter !== "all" && item.state !== stateFilter) return false;
      if (!n) return true;
      const scopeLabel = (item.scope ?? []).map(scopeText).join(" ").toLowerCase();
      return item.id.toLowerCase().includes(n) || scopeLabel.includes(n) || label(SUPPORT_SESSION_STATE, item.state).toLowerCase().includes(n);
    });
  }, [sessions, stateFilter, q]);
  const { effectiveId, select, dismiss, resetDismiss } = useDesktopAutoSelect({
    rows,
    getId: (item) => item.id,
    explicitId: selectedId,
    onSelectExplicit: setSelectedId,
    onClearExplicit: () => setSelectedId(undefined),
  });
  const selected = sessions.find((item) => item.id === effectiveId);
  const me = operatorId();
  const empty = activeOrgs.length === 0 || (sessionsQ.data !== undefined && sessions.length === 0);
  const requestedCount = sessions.filter((item) => item.state === "REQUESTED").length;
  const opApprovedCount = sessions.filter((item) => item.state === "OPERATOR_APPROVED").length;
  const activeCount = sessions.filter((item) => item.state === "ACTIVE").length;
  const statItems: StatRowItem[] = [
    { key: "all", label: t("tenants.view.all"), value: fmtNumber(sessions.length), active: stateFilter === "all", onPress: () => setStateFilter("all") },
    { key: "requested", label: t("supportAccess.state.REQUESTED"), value: fmtNumber(requestedCount), tone: requestedCount > 0 ? "warn" : "muted", active: stateFilter === "REQUESTED", onPress: () => setStateFilter("REQUESTED") },
    { key: "opApproved", label: t("supportAccess.state.OPERATOR_APPROVED"), value: fmtNumber(opApprovedCount), tone: opApprovedCount > 0 ? "primary" : "muted", active: stateFilter === "OPERATOR_APPROVED", onPress: () => setStateFilter("OPERATOR_APPROVED") },
    { key: "active", label: t("supportAccess.state.ACTIVE"), value: fmtNumber(activeCount), tone: activeCount > 0 ? "ok" : "muted", active: stateFilter === "ACTIVE", onPress: () => setStateFilter("ACTIVE") },
  ];

  return (
    <ListRecord
      tabs={tabs}
      q={listState}
      head={{
        title: t("tenants.support.title"),
        titleId: "support-title",
        actions: (
          <div className={s.headActions}>
            <Button size="sm" variant="secondary" onClick={() => setLookupOpen(true)}>
              <Search size={13} aria-hidden />
              {t("tenants.supportLookup.title")}
            </Button>
          </div>
        ),
        primary: effectiveOrg && !empty
          ? { id: "request-support", label: t("tenants.support.request"), onAction: () => setRequesting(true) }
          : undefined,
      }}
      find={
        activeOrgs.length > 0 && sessions.length > 0 ? (
          <div className={s.findWrap} data-list-find="">
            <WorklistSearchField label={t("tenants.support.search")} value={q} onChange={setQ} />
          </div>
        ) : undefined
      }
      stats={activeOrgs.length > 0 && sessions.length > 0 ? <StatRow label={t("tenants.support.stat.label")} items={statItems} /> : undefined}
      filters={
        activeOrgs.length > 0 ? (
          <SelectField
            hideLabel
            label={t("tenants.support.selectOrg")}
            placeholder={t("tenants.support.pickOrg")}
            value={effectiveOrg?.id ?? null}
            onChange={(id) => {
              setSelectedOrgId(id);
              setSelectedId(undefined);
              setStateFilter("all");
              setQ("");
              resetDismiss();
            }}
            options={activeOrgs.map((o) => ({ id: o.id, label: `${o.name} (${o.slug})` }))}
          />
        ) : undefined
      }
      notes={
        <>
          {effectiveOrg ? (
            <RecordBannerBand tone="neutral">
              <bdi>{t("tenants.support.metadataNotice")}</bdi>
            </RecordBannerBand>
          ) : null}
          {recorded ? <Receipt state="recorded" message={recorded.message} meta={recorded.meta} /> : null}
        </>
      }
      list={
        <div ref={tableRef} id="support-list" className={s.tableWrap}>
          {activeOrgs.length === 0 ? (
            <EmptyState title={t("tenants.support.noOrgsTitle")} reason={t("tenants.support.noOrgsReason")} />
          ) : sessions.length === 0 ? (
            <EmptyState
              title={t("tenants.support.empty.title")}
              reason={t("tenants.support.empty.reason")}
              actions={
                <Button variant="primary" onClick={() => setRequesting(true)}>
                  {t("tenants.support.request")}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t("tenants.view.empty")}
              reason={t("tenants.view.emptyReason")}
              actions={<Button onClick={() => { setQ(""); setStateFilter("all"); }}>{t("tenants.rail.reset")}</Button>}
            />
          ) : (
            <Table
              label={t("tenants.support.title")}
              rows={rows}
              rowId={(item: SupportSessionMetadata) => item.id}
              selected={effectiveId}
              onSelect={select}
              mobileLayout="compact"
              density="compact"
              columns={[
                { header: t("tenants.support.col.session"), card: "title", cell: (item) => <code>{item.id.slice(0, 8)}</code> },
                {
                  header: t("tenants.support.col.state"),
                  card: "status",
                  fit: true,
                  cell: (item) => <EnumValue e={SUPPORT_SESSION_STATE} value={item.state} />,
                },
                {
                  header: t("tenants.support.col.scope"),
                  card: "fact",
                  cell: (item) => (
                    <bdi className={s.nowrap}>
                      {item.scope?.length ? item.scope.map(scopeText).join(" · ") : "—"}
                    </bdi>
                  ),
                },
                {
                  header: t("tenants.support.col.duration"),
                  card: "omit",
                  fit: true,
                  cell: (item) => (
                    <bdi className={`num ${s.nowrap}`}>
                      {item.requested_duration_seconds
                        ? t("tenants.support.durationMinutes", { minutes: Math.round(item.requested_duration_seconds / 60) })
                        : "—"}
                    </bdi>
                  ),
                },
                {
                  header: t("tenants.support.col.tenantConsent"),
                  card: "omit",
                  fit: true,
                  cell: (item) => t(item.tenant_approved ? "tenants.support.consent.yes" : "tenants.support.consent.no"),
                },
                {
                  header: t("tenants.support.col.requested"),
                  card: "omit",
                  wide: true,
                  fit: true,
                  cell: (item) => <bdi className={`num ${s.nowrap}`}>{fmtDate(item.requested_at)}</bdi>,
                },
                {
                  header: t("tenants.support.col.expires"),
                  card: "omit",
                  wide: true,
                  fit: true,
                  cell: (item) => <bdi className={`num ${s.nowrap}`}>{item.expires_at ? fmtDate(item.expires_at) : "—"}</bdi>,
                },
              ]}
            />
          )}
        </div>
      }
      full={full}
      onFull={setFull}
      onSelect={select}
      record={
        selected
          ? {
              id: selected.id,
              label: selected.id.slice(0, 8),
              title: `${t("tenants.support.col.session")} · ${selected.id.slice(0, 8)}`,
              meta: effectiveOrg?.name,
              onClose: dismiss,
              returnFocus: () => rowById(tableRef.current, selected.id),
              children: (
                <SupportSessionPanel
                  key={selected.id}
                  session={selected}
                  currentOperatorId={me}
                  onApproved={() => setRecorded({ message: t("tenants.support.approveDone") })}
                  onStarted={(outcome) => setStartedToken(outcome)}
                  onEnded={() => setRecorded({ message: t("tenants.support.endDone") })}
                />
              ),
            }
          : null
      }
      statusSegments={
        effectiveOrg
          ? [
              { id: "scope", content: t("shell.hub.platform"), tone: "strong" },
              { id: "tab", content: t("tenants.tab.support") },
              { id: "org", content: effectiveOrg.name },
              { id: "count", content: fmtNumber(rows.length) },
            ]
          : null
      }
      overlays={
        <>
          {effectiveOrg && requesting ? (
            <RequestSupportDialog
              open
              orgs={activeOrgs}
              initialOrg={effectiveOrg}
              onClose={() => setRequesting(false)}
              onRequested={(res, targetOrgId) => {
                setRequesting(false);
                setSelectedOrgId(targetOrgId);
                select(res.id);
                setRecorded({ message: t("tenants.support.requestDone") });
              }}
            />
          ) : null}
          <SupportTokenDialog outcome={startedToken} onClose={() => setStartedToken(null)} />
          <Dialog open={lookupOpen} title={t("tenants.supportLookup.title")} onClose={() => setLookupOpen(false)}>
            <SupportLookup />
            <div className="form__actions">
              <Button onClick={() => setLookupOpen(false)}>{t("tenants.code.close")}</Button>
            </div>
          </Dialog>
        </>
      }
    />
  );
}
