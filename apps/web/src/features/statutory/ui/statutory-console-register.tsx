// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup, type ReadState } from "../../../lib/react/query-view";
import type { RegisterPage } from "../../../reference/statutory/api";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import s from "./statutory-console.module.css";

const MISSING_FIELD: Record<
  string,
  { label: "name" | "sex" | "birth" | "address" | "job" | "contract" | "history" | "exit"; act?: string; hash?: string }
> = {
  name: { label: "name", act: "fix:name" },
  sex: { label: "sex", act: "fix:sex" },
  birth: { label: "birth", act: "fix:birth_date" },
  address: { label: "address", act: "fix:address" },
  job: { label: "job", act: "fix:job" },
  hire: { label: "contract", act: "fix:hire_date" },
  contract: { label: "contract", hash: "s5" },
  history: { label: "history", hash: "s5" },
  exit: { label: "exit", hash: "s1" },
};

export function RegisterTabMain({
  site,
  date,
  validDate,
  workplaces,
  registerRead,
  regAfter,
  setRegAfter,
}: {
  site?: string;
  date: string;
  validDate: boolean;
  workplaces: ReadState;
  registerRead: ReadState<RegisterPage>;
  regAfter?: string;
  setRegAfter: (next: string | undefined) => void;
}) {
  if (!site) {
    return (
      <div className={s.mainStack}>
        <EmptyState
          title={t("statutory.noSite")}
          reason={t("statutory.noSiteReason")}
          actions={<Link to="/org" className={buttonClass()}>{t("statutory.openStructure")}</Link>}
        />
      </div>
    );
  }
  if (!validDate) return null;
  return (
    <QueryState q={readGroup([workplaces, registerRead])} layout="list">
      {() => {
        const data = registerRead.data!;
        const regCols: LongColumn<RegisterPage["items"][number]>[] = [
          ...data.headers.map((header, i) => ({
            id: `col-${i}`,
            header,
            card: (i === 1 ? "title" : i === 0 || i === 2 ? "fact" : "omit") as LongColumn<RegisterPage["items"][number]>["card"],
            rowHeader: i === 1,
            minWidth: i === 1 ? 120 : 100,
            cell: (r: RegisterPage["items"][number]) =>
              i === 1 ? (
                <Link to="/people/$id" params={{ id: r.employee_id }} className={s.plainLink}>
                  {r.cells[i]}
                </Link>
              ) : (
                r.cells[i] || ""
              ),
          })),
          {
            id: "missing",
            header: t("statutory.missing"),
            card: "status",
            minWidth: 160,
            cell: (r) =>
              r.missing.length === 0 ? null : (
                <Link
                  to="/people/$id"
                  params={{ id: r.employee_id }}
                  search={{ act: MISSING_FIELD[r.missing[0]!]?.act }}
                  hash={MISSING_FIELD[r.missing[0]!]?.hash}
                  className={s.plainLink}
                >
                  <Chip tone="warn">{t("statutory.missingCount", { count: r.missing.length })}</Chip>
                </Link>
              ),
          },
        ];
        return (
          <div className={s.mainStack}>
            {data.items.length > 0 ? (
              <LongTable
                label={t("statutory.register")}
                caption={`${t("statutory.asOf")} ${fmtDate(date)} · ${t("statutory.people", { count: data.total })}`}
                rows={data.items}
                rowId={(r) => r.employee_id}
                total={data.total}
                mobileLayout="compact"
                empty={null}
                hasMore={Boolean(data.next)}
                onLoadMore={() => { if (data.next) setRegAfter(data.next); }}
                columns={regCols}
              />
            ) : (
              <EmptyState
                title={t("statutory.noWorkers")}
                reason={t("statutory.noWorkersReason")}
                actions={<Link to="/people" className={buttonClass()}>{t("statutory.openPeople")}</Link>}
              />
            )}
            {regAfter ? (
              <div className={s.pagerRow}>
                <Button size="sm" onClick={() => setRegAfter(undefined)}>{t("common.back")}</Button>
              </div>
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}
