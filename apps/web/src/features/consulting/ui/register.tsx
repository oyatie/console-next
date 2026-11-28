// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { Pager } from "../../../ui/pager";
import { ListRecord } from "../../../ui/patterns/list-record";
import { Composer } from "../../../ui/composer/composer";
import { createEngagement, engagements, listQuery } from "../api";
import { OptionField } from "./option-field";

export function ConsultingRegister() {
  const canManage = useServedCapability("served_consulting_manage");
  const [q, search] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, select] = useState<string>();
  const [editing, edit] = useState(false);
  const query = useQuery(listQuery(q, offset));
  const rows = query.data?.items ?? [];
  const row = rows.find(r => r.id === selected);
  const title = t("consulting.title");
  return <ListRecord q={query} head={{ title, titleId: "consulting-register",
    actions: canManage && <Button variant="primary" onClick={() => edit(true)}>{t("consulting.create")}</Button> }}
    find={<Field label={t("consulting.search")} required={null}>{p => <TextInput {...p} value={q}
      onChange={e => { search(e.target.value); setOffset(0); select(undefined); }} />}</Field>}
    list={<LongTable label={title} rows={rows} rowId={r => r.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
      onRowAction={select} activeRowId={row?.id} empty={<EmptyState title={t("consulting.empty")} reason={null} />} columns={[
        { id: "title", header: t("consulting.name"), rowHeader: true, card: "title", cell: r => r.title },
        { id: "status", header: t("consulting.state"), card: "status", cell: r => t(`consulting.stage.${r.status}`) },
        { id: "updated", header: t("consulting.updated"), card: "fact", cell: r => fmtDateTime(r.updated_at) },
      ]} />}
    record={row && { id: row.id, title: row.title, label: t("consulting.detail"), onClose: () => select(undefined),
      children: <KeyValue items={[{ key: "version", label: t("consulting.version"), value: row.version },
        { key: "state", label: t("consulting.state"), value: t(`consulting.stage.${row.status}`) }]} />,
      expand: <Link to="/consulting/engagements/$engagementId" params={{ engagementId: row.id }}>{t("consulting.detail")}</Link> }}
    foot={query.data && <Pager offset={offset} limit={25} total={query.data.total} onPage={p => { setOffset(p); select(undefined); }} />}
    overlays={canManage && editing && <CreateEngagement onClose={() => edit(false)} />} />;
}

function CreateEngagement({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [customerId, customer] = useState("");
  const [document, setDocument] = useState("");
  const [ontology, setOntology] = useState("");
  const command = useCommand({ run: createEngagement, invalidates: [engagements],
    onSuccess: row => { onClose(); void navigate({ to: "/consulting/engagements/$engagementId", params: { engagementId: row.id } }); } });
  return <Composer open title={t("consulting.create")} action={{kind: "consultingEngagement", mode: "record"}}
    onClose={onClose} pending={command.isPending} error={command.error} notice={<CommandError error={command.error} />}
    consequence={title.trim()} incomplete={!title.trim() || !customerId}
    onSubmit={() => { if (!title.trim() || !customerId || command.isPending) return false;
      command.mutate({ title: title.trim(), customerId, customerDocumentId: document || undefined, ontologyInstanceId: ontology || undefined }); }}>
    <Field label={t("consulting.name")} required>{p => <TextInput {...p} maxLength={180} value={title} onChange={e => setTitle(e.target.value)} />}</Field>
    <OptionField kind="CUSTOMER" label={t("consulting.customer")} required value={customerId} onChange={customer} />
    <OptionField kind="DOCUMENT" label={t("consulting.document")} required={false} value={document} onChange={setDocument} />
    <OptionField kind="ONTOLOGY_INSTANCE" label={t("consulting.ontology")} required={false} value={ontology} onChange={setOntology} />
  </Composer>;
}
