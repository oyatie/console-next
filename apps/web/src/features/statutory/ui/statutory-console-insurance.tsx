// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup, type ReadState } from "../../../lib/react/query-view";
import type { FilingPage } from "@console/api/pending";
import type { FilingTask } from "../../../reference/statutory/api";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable } from "../../../ui/long-table/long-table";
import type { Selection } from "../../../ui/long-table/selection";
import { buildFilingColumns, taskKey } from "./statutory-console-columns";
import s from "./statutory-console.module.css";

export function InsuranceTabMain({
  workplaces,
  tasks,
  visibleRows,
  urgentOnly,
  state,
  inspectedTask,
  setInspectedId,
  selection,
  setSelection,
  onEdiExport,
  after,
  setAfter,
}: {
  workplaces: ReadState;
  tasks: ReadState<FilingPage>;
  visibleRows: FilingTask[];
  urgentOnly: boolean;
  state: "PENDING" | "DONE";
  inspectedTask: FilingTask | null;
  setInspectedId: (id: string | null) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  onEdiExport: () => void;
  after?: string;
  setAfter: (next: string | undefined) => void;
}) {
  const filingColumns = buildFilingColumns(setInspectedId, state);
  return (
    <QueryState q={readGroup([workplaces, tasks])} layout="list">
      {() => {
        const page = tasks.data!;
        return (
          <div className={s.mainStack}>
            {visibleRows.length > 0 ? (
              <LongTable
                label={t("statutory.insurance")}
                rows={visibleRows}
                rowId={taskKey}
                total={urgentOnly ? visibleRows.length : page.total}
                mobileLayout="compact"
                empty={null}
                hasMore={Boolean(page.next)}
                onLoadMore={() => { if (page.next) setAfter(page.next); }}
                activeRowId={inspectedTask ? taskKey(inspectedTask) : undefined}
                onRowAction={(id) => setInspectedId(id)}
                selection={state === "PENDING" ? selection : undefined}
                onSelectionChange={state === "PENDING" ? setSelection : undefined}
                selectionActions={
                  state === "PENDING" ? (
                    <Button variant="primary" size="sm" className={s.nowrap} onClick={onEdiExport}>
                      {t("statutory.ediExport")}
                    </Button>
                  ) : undefined
                }
                columns={filingColumns}
              />
            ) : (
              <EmptyState
                title={t("statutory.empty")}
                reason={t("statutory.emptyReason")}
                actions={<Link to="/people" className={buttonClass()}>{t("statutory.openPeople")}</Link>}
              />
            )}
            {after ? (
              <div className={s.pagerRow}>
                <Button size="sm" onClick={() => setAfter(undefined)}>{t("common.back")}</Button>
              </div>
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}
