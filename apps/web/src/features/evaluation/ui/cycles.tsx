// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { Pager } from "../../../ui/pager";
import { ListRecord } from "../../../ui/patterns/list-record";
import { cyclesQuery } from "../api";
import { PAGE_SIZE, stages } from "../domain/cycles";

const route = getRouteApi("/app/evaluation");

export function EvaluationCycles() {
  const { page = 0, stage } = route.useSearch();
  const navigate = route.useNavigate();
  const canCreate = useServedCapability("served_evaluation_cycle_create");
  const query = useQuery(cyclesQuery(stage, page));
  const [selected, select] = useState<string>();
  const rows = query.data?.items ?? [];
  const record = rows.find(row => row.id === selected);
  const title = t("evaluation.title");
  const setPage = (page: number) => {
    select(undefined);
    void navigate({ search: { page: page || undefined, stage }, replace: true });
  };
  return <ListRecord q={query} head={{ title, titleId: "evaluation-cycles-title", actions: canCreate &&
    <Link to="/evaluation/new" className={buttonClass("primary")}>{t("evaluation.create")}</Link> }}
    filters={<Field label={t("evaluation.stage")} required={null}>{p =>
      <SelectInput {...p} value={stage ?? ""} onChange={e => {
        select(undefined);
        void navigate({ search: { stage: stages.find(value => value === e.target.value) }, replace: true });
      }}>
        <option value="">{t("evaluation.active")}</option>
        {stages.map(s => <option key={s} value={s}>{t(`evaluation.stage.${s}`)}</option>)}
      </SelectInput>}</Field>}
    list={<LongTable label={title} rows={rows} rowId={row => row.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
      empty={<EmptyState title={t("evaluation.empty")} reason={null} />} onRowAction={select} activeRowId={record?.id}
      columns={[
        { id: "name", header: t("evaluation.name"), rowHeader: true, card: "title", cell: row => row.name },
        { id: "period", header: t("evaluation.period"), card: "fact", cell: row => row.period_label },
        { id: "kind", header: t("evaluation.kind"), card: "fact", cell: row => t(`evaluation.kind.${row.kind}`) },
        { id: "due", header: t("me.evaluation.due"), card: "fact", cell: row => fmtDate(row.due_date) },
        { id: "stage", header: t("evaluation.stage"), card: "status", cell: row => t(`evaluation.stage.${row.stage}`) },
      ]} />}
    record={record && { id: record.id, title: record.name, label: t("evaluation.progress"), onClose: () => select(undefined),
      children: <KeyValue items={[
        { key: "subjects", label: t("evaluation.subjects"), value: record.subjects_total },
        { key: "self", label: t("evaluation.self"), value: record.self_submitted },
        { key: "manager", label: t("evaluation.manager"), value: record.manager_submitted },
        { key: "calibrated", label: t("evaluation.calibrated"), value: record.calibrated },
        { key: "finalized", label: t("evaluation.finalized"), value: record.finalized },
      ]} /> }}
    foot={query.data && <Pager offset={page * PAGE_SIZE} limit={PAGE_SIZE} total={query.data.total}
      onPage={offset => setPage(Math.floor(offset / PAGE_SIZE))} />} />;
}
