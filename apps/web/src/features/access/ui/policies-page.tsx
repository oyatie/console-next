// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import {
  createPolicyDraft,
  POLICY_READS,
  policyAuditEventsQuery,
  policyCatalogQuery,
  policyDecisionsQuery,
  policyDraftsQuery,
  type PolicyCatalogEntry,
  type PolicyDraftRecord,
  type PolicyNoCodeBlocks,
} from "../policy-api";
import { AccessNavTabs } from "./access-head";
import s from "./access.module.css";

type ViewTab = "catalog" | "drafts" | "decisions" | "audit";

export function PoliciesPage() {
  return (
    <AccessGate domain="access" level="edit" tenant>
      <PoliciesWorkspace />
    </AccessGate>
  );
}

function PoliciesWorkspace() {
  const navigate = useNavigate();
  const catalog = useQuery(policyCatalogQuery);
  const drafts = useQuery(policyDraftsQuery);
  const [tab, setTab] = useState<ViewTab>("catalog");
  const decisions = useQuery({ ...policyDecisionsQuery, enabled: tab === "decisions" });
  const auditEvents = useQuery({ ...policyAuditEventsQuery, enabled: tab === "audit" });

  const [selectedDraft, setSelectedDraft] = useState<PolicyDraftRecord | null>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<PolicyCatalogEntry | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [effect, setEffect] = useState<"permit" | "forbid">("permit");
  const [action, setAction] = useState<PolicyNoCodeBlocks["action"]>("view");
  const [resourceType, setResourceType] = useState("employee");

  const createCmd = useCommand({
    run: () =>
      createPolicyDraft({
        draft_key: draftKey.trim(),
        title: title.trim(),
        author_note: note.trim() || null,
        blocks: { effect, action, resource_type: resourceType.trim(), conditions: [] },
      }),
    invalidates: POLICY_READS,
    announce: () => t("accessPolicies.draft.saved"),
    onSuccess: (created) => {
      setCreateOpen(false);
      void navigate({ to: "/access/policies/$draftId", params: { draftId: created.id } });
    },
  });

  const catalogRows = catalog.data ?? [];
  const draftRows = drafts.data ?? [];
  const decisionRows = decisions.data ?? [];
  const auditRows = auditEvents.data ?? [];

  const renderList = () => {
    if (tab === "catalog") {
      return catalogRows.length === 0 ? (
        <EmptyState title={t("accessPolicies.emptyCatalog")} reason={null} />
      ) : (
        <Table<PolicyCatalogEntry>
          label={t("accessPolicies.tab.catalog")}
          rows={catalogRows}
          rowId={(r) => r.policy_id ?? r.id ?? r.title ?? "policy"}
          selected={selectedCatalog?.policy_id ?? selectedCatalog?.id}
          onSelect={(id) => setSelectedCatalog(catalogRows.find((r) => (r.policy_id ?? r.id) === id) ?? null)}
          density="compact"
          columns={[
            { header: t("accessPolicies.col.title"), card: "title", cell: (r) => r.title ?? r.policy_id ?? r.id ?? "—" },
            { header: t("accessPolicies.col.status"), card: "status", cell: (r) => <Chip tone="info">{r.status ?? "enforced"}</Chip> },
            { header: t("accessPolicies.col.effect"), card: "fact", cell: (r) => r.effect ?? "—" },
            { header: t("accessPolicies.col.updated"), card: "fact", cell: (r) => (r.updated_at ? fmtDateTime(r.updated_at) : "—") },
          ]}
        />
      );
    }
    if (tab === "drafts") {
      return draftRows.length === 0 ? (
        <EmptyState title={t("accessPolicies.emptyDrafts")} reason={null} />
      ) : (
        <Table<PolicyDraftRecord>
          label={t("accessPolicies.tab.drafts")}
          rows={draftRows}
          rowId={(r) => r.id}
          selected={selectedDraft?.id}
          onSelect={(id) => setSelectedDraft(draftRows.find((r) => r.id === id) ?? null)}
          density="compact"
          columns={[
            { header: t("accessPolicies.col.title"), card: "title", cell: (r) => r.title },
            { header: t("accessPolicies.col.status"), card: "status", cell: (r) => <Chip tone={r.status === "approved_for_promotion" ? "ok" : "neutral"}>{r.status}</Chip> },
            { header: t("accessPolicies.col.effect"), card: "fact", cell: (r) => r.blocks?.effect ?? "—" },
            {
              header: t("accessPolicies.openDraft"),
              type: "action",
              card: "action",
              cell: (r) => (
                <Link to="/access/policies/$draftId" params={{ draftId: r.id }} className={buttonClass("secondary", { size: "sm" })}>
                  {t("accessPolicies.openDraft")}
                </Link>
              ),
            },
          ]}
        />
      );
    }
    if (tab === "decisions") {
      return decisionRows.length === 0 ? (
        <EmptyState title={t("accessPolicies.emptyDecisions")} reason={null} />
      ) : (
        <Table
          label={t("accessPolicies.tab.decisions")}
          rows={decisionRows}
          rowId={(r) => `${r.id ?? r.subject_ref ?? ""}:${r.action ?? ""}:${r.decided_at ?? ""}`}
          density="compact"
          columns={[
            { header: t("accessPolicies.col.title"), card: "title", cell: (r) => `${r.action ?? "—"} · ${r.resource_type ?? "—"}` },
            { header: t("accessPolicies.col.effect"), card: "status", cell: (r) => <Chip tone={r.effect === "allow" ? "ok" : "warn"}>{r.effect ?? "—"}</Chip> },
            { header: t("accessPolicies.col.updated"), card: "fact", cell: (r) => (r.decided_at ? fmtDateTime(r.decided_at) : "—") },
          ]}
        />
      );
    }
    return auditRows.length === 0 ? (
      <EmptyState title={t("accessPolicies.emptyAudit")} reason={null} />
    ) : (
      <Table
        label={t("accessPolicies.tab.audit")}
        rows={auditRows}
        rowId={(r) => String(r.id ?? JSON.stringify(r))}
        density="compact"
        columns={[
          { header: t("accessPolicies.col.title"), card: "title", cell: (r) => String(r.action ?? "policy.event") },
          { header: t("accessPolicies.col.status"), card: "fact", cell: (r) => String(r.target_id ?? "—") },
        ]}
      />
    );
  };

  const activeRecord =
    tab === "drafts" && selectedDraft
      ? {
          id: selectedDraft.id,
          label: selectedDraft.title,
          title: selectedDraft.title,
          meta: selectedDraft.draft_key,
          onClose: () => setSelectedDraft(null),
          children: (
            <RecordPaneSection title={selectedDraft.title}>
              <KeyValue
                items={[
                  { key: "status", label: t("accessPolicies.col.status"), value: selectedDraft.status },
                  { key: "effect", label: t("accessPolicies.col.effect"), value: selectedDraft.blocks?.effect ?? "—" },
                  { key: "action", label: t("accessPolicies.form.action"), value: selectedDraft.blocks?.action ?? "—" },
                  { key: "res", label: t("accessPolicies.form.resourceType"), value: selectedDraft.blocks?.resource_type ?? "—" },
                ]}
              />
              <div className={s.actions}>
                <Link to="/access/policies/$draftId" params={{ draftId: selectedDraft.id }} className={buttonClass("primary", { size: "sm" })}>
                  {t("accessPolicies.openDraft")}
                </Link>
              </div>
            </RecordPaneSection>
          ),
        }
      : tab === "catalog" && selectedCatalog
        ? {
            id: selectedCatalog.policy_id ?? selectedCatalog.id ?? "catalog",
            label: selectedCatalog.title ?? t("accessPolicies.title"),
            title: selectedCatalog.title ?? selectedCatalog.policy_id ?? "—",
            onClose: () => setSelectedCatalog(null),
            children: (
              <RecordPaneSection title={t("accessPolicies.tab.catalog")}>
                <KeyValue
                  items={[
                    { key: "id", label: t("accessPolicies.col.title"), value: selectedCatalog.policy_id ?? selectedCatalog.id ?? "—" },
                    { key: "status", label: t("accessPolicies.col.status"), value: selectedCatalog.status ?? "enforced" },
                    { key: "effect", label: t("accessPolicies.col.effect"), value: selectedCatalog.effect ?? "—" },
                  ]}
                />
              </RecordPaneSection>
            ),
          }
        : undefined;

  return (
    <ListRecord
      q={catalog}
      tabs={<AccessNavTabs failed={Boolean(catalog.error)} />}
      head={{
        title: t("accessPolicies.title"),
        primary: { id: "new-draft", label: t("accessPolicies.newDraft"), onAction: () => setCreateOpen(true) },
        actions: (
          <div className={s.actions}>
            {(["catalog", "drafts", "decisions", "audit"] as const).map((k) => (
              <Button key={k} size="sm" variant={tab === k ? "secondary" : "ghost"} onClick={() => setTab(k)}>
                {t(`accessPolicies.tab.${k}`)}
              </Button>
            ))}
          </div>
        ),
      }}
      list={renderList()}
      record={activeRecord}
      overlays={
        <Dialog open={createOpen} title={t("accessPolicies.newDraft")} onClose={() => setCreateOpen(false)}>
          <CommandError error={createCmd.error} />
          <Field label={t("accessPolicies.form.draftKey")} required>
            {(p) => <TextInput {...p} value={draftKey} onChange={(e) => setDraftKey(e.target.value)} />}
          </Field>
          <Field label={t("accessPolicies.form.title")} required>
            {(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <ChoiceField
            label={t("accessPolicies.form.effect")}
            required
            value={effect}
            onChange={(v) => setEffect(v as "permit" | "forbid")}
            options={[
              { value: "permit", label: "permit" },
              { value: "forbid", label: "forbid" },
            ]}
          />
          <SelectField
            label={t("accessPolicies.form.action")}
            placeholder={t("accessPolicies.form.action")}
            value={action}
            onChange={(v) => setAction(v as PolicyNoCodeBlocks["action"])}
            options={[
              { id: "view", label: "view" },
              { id: "edit", label: "edit" },
              { id: "read_field", label: "read_field" },
              { id: "console:configure", label: "console:configure" },
              { id: "console:deploy", label: "console:deploy" },
            ]}
          />
          <Field label={t("accessPolicies.form.resourceType")} required>
            {(p) => <TextInput {...p} value={resourceType} onChange={(e) => setResourceType(e.target.value)} />}
          </Field>
          <Field label={t("accessPolicies.form.note")} required={false}>
            {(p) => <TextInput {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className="form__actions">
            <Button onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!draftKey.trim() || !title.trim() || !resourceType.trim() || createCmd.isPending}
              onClick={() => createCmd.mutate(undefined)}
            >
              {t("accessPolicies.form.create")}
            </Button>
          </div>
        </Dialog>
      }
    />
  );
}
