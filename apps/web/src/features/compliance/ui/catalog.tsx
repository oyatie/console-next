// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { Pager } from "../../../ui/pager";
import { ListRecord } from "../../../ui/patterns/list-record";
import { controlsQuery, frameworksQuery, obligationsQuery, PAGE_SIZE, regulationsQuery, type View } from "../api";
import { BranchField } from "./scope";
import { useCatalogScope } from "./use-catalog-scope";
import { complianceCode } from "./words";

export function ComplianceCatalog() {
  const scope = useCatalogScope("read");
  const canManage = useServedCapability("served_compliance_catalog_manage");
  const [view, setView] = useState<View>("frameworks");
  const [framework, setFramework] = useState<{ id: string; name: string }>();
  const [branch, setBranch] = useState("");
  const [selected, select] = useState("");
  const [page, setPage] = useState(0);
  const current = scope.orgWide ? view : "obligations";
  const activeBranch = scope.ids.includes(branch) ? branch : !scope.orgWide && scope.ids.length === 1 ? scope.ids[0] : undefined;
  const reset = () => { select(""); setPage(0); };
  const frameworks = useQuery({ ...frameworksQuery(page), enabled: current === "frameworks" && scope.orgWide });
  const regulations = useQuery({ ...regulationsQuery(page), enabled: current === "regulations" && scope.orgWide });
  const ready = scope.orgWide || !!activeBranch;
  const obligations = useQuery({ ...obligationsQuery(page, activeBranch), enabled: current === "obligations" && ready });
  const controls = useQuery({ ...controlsQuery(page, framework?.id ?? ""), enabled: current === "controls" && !!framework && scope.orgWide });
  const query = { frameworks, obligations, regulations, controls }[current];
  const rows: Array<{ id: string; title: string; code: string; kind: Parameters<typeof complianceCode>[0]; status: Parameters<typeof complianceCode>[0]; detail: string }> | undefined = current === "frameworks" ? frameworks.data?.items.map(r => ({ ...r, title: r.name, code: r.code, kind: r.framework_kind, detail: r.version_label }))
    : current === "obligations" ? obligations.data?.items.map(r => ({ ...r, kind: r.obligation_type, detail: r.description }))
    : current === "regulations" ? regulations.data?.items.map(r => ({ ...r, kind: r.risk_level, detail: [r.jurisdiction, r.citation, r.impact_summary].join(" · ") }))
    : controls.data?.items.map(r => ({ ...r, code: r.control_key, kind: r.control_type, detail: r.objective }));
  const record = rows?.find(r => r.id === selected);
  const label = t(`compliance.view.${current}`);
  return <ListRecord q={ready ? query : scope.branches} head={{ title: t("compliance.title"), titleId: "compliance-catalog", actions: canManage &&
    <Link to="/compliance/new" className={buttonClass("primary")}>{t("compliance.create")}</Link> }}
    filters={<>
      {scope.orgWide && <Field label={t("compliance.register")} required={null}>{p => <SelectInput {...p} value={current} onChange={e => {
        const next = (["frameworks", "obligations", "regulations", "controls"] as const).find(k => k === e.target.value);
        if (next) { reset(); setView(next); }
      }}>
        {(["frameworks", "regulations", "obligations"] as const).map(k => <option key={k} value={k}>{t(`compliance.view.${k}`)}</option>)}
        {framework && <option value="controls">{t("compliance.controlsFor", { name: framework.name })}</option>}
      </SelectInput>}</Field>}
      {current === "obligations" && <BranchField scope={scope} all={scope.orgWide} value={activeBranch ?? ""} onChange={v => { reset(); setBranch(v); }} />}
    </>}
    list={ready ? <LongTable label={label} rows={rows ?? []} rowId={r => r.id} total={rows?.length ?? 0} hasMore={false} onLoadMore={() => {}}
      empty={<EmptyState title={t("compliance.empty")} reason={null} />} onRowAction={select} activeRowId={record?.id}
      columns={[
        { id: "title", header: t("compliance.name"), rowHeader: true, card: "title", cell: r => r.title },
        { id: "code", header: t("compliance.code"), card: "fact", cell: r => r.code },
        { id: "status", header: t("compliance.status"), card: "fact", cell: r => complianceCode(r.status) },
      ]} /> : <EmptyState title={t("compliance.chooseBranch")} reason={null} />}
    record={record && { id: record.id, title: record.title, label, meta: record.code, onClose: () => select(""),
      children: <><KeyValue items={[
        { key: "kind", label: t("compliance.kind"), value: complianceCode(record.kind) },
        { key: "detail", label: t("compliance.detail"), value: record.detail },
        { key: "id", label: t("compliance.reference"), value: record.id },
      ]} />{current === "frameworks" && <Button onClick={() => { setFramework({ id: record.id, name: record.title }); reset(); setView("controls"); }}>{t("compliance.view.controls")}</Button>}</> }}
    foot={ready && query.data && <Pager offset={page * PAGE_SIZE} limit={PAGE_SIZE} total={query.data.total} onPage={offset => { select(""); setPage(offset / PAGE_SIZE); }} />} />;
}
