// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import type { components } from "@console/api/schema";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { evaluationTasksQuery } from "../api";

type Task = components["schemas"]["EvaluationTaskItem"];
const taskId = (task: Task) => `${task.subject_id}:${task.kind}`;
const kind = (task: Task) => t(task.kind === "SELF" ? "me.evaluation.self" : "me.evaluation.manager");
const status = (task: Task) => t(task.review_status === null ? "me.evaluation.pending"
  : task.review_status === "DRAFT" ? "me.evaluation.draft" : "me.evaluation.submitted");

export function EvaluationTasks() {
  const query = useQuery(evaluationTasksQuery);
  const [selected, select] = useState<string | null>();
  const desktop = useIsDesktop();
  const tasks = query.data?.items ?? [];
  const current = selected === undefined && desktop ? tasks[0] : tasks.find(task => taskId(task) === selected);
  const title = t("me.evaluation.title");
  return <ListRecord q={query} head={{ title, titleId: "my-evaluations-title" }}
    list={<LongTable label={title} rows={tasks} rowId={taskId} total={tasks.length} hasMore={false}
      empty={<EmptyState title={t("me.evaluation.empty")} reason={null} />}
      onLoadMore={() => {}} onRowAction={select} activeRowId={current && taskId(current)}
      columns={[
        { id: "person", header: t("account.field.name"), rowHeader: true, card: "title", cell: task => task.employee_name },
        { id: "cycle", header: t("me.evaluation.cycle"), card: "fact", cell: task => task.cycle_name },
        { id: "kind", header: t("me.evaluation.kind"), card: "fact", cell: kind },
        { id: "due", header: t("me.evaluation.due"), card: "fact", cell: task => fmtDate(task.due_date) },
        { id: "status", header: t("requestOutcome.myHistory.col.state"), card: "status", cell: status },
       ]} />}
    record={current && { id: taskId(current), title: current.employee_name, label: kind(current),
      onClose: () => select(null), children: <KeyValue items={[
        { key: "cycle", label: t("me.evaluation.cycle"), value: current.cycle_name },
        { key: "kind", label: t("me.evaluation.kind"), value: kind(current) },
        { key: "due", label: t("me.evaluation.due"), value: fmtDate(current.due_date) },
        { key: "status", label: t("requestOutcome.myHistory.col.state"), value: status(current) },
      ]} /> }} />;
}
