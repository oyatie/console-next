// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import {
  ACCESS_REVIEW_READS,
  accessReviewDetailQuery,
  accessReviewsQuery,
  completeAccessReview,
  exportAccessReviewCsv,
  startAccessReview,
  type AccessReviewItem,
} from "../api/policy";
import { AccessReviewDecisionComposer } from "./access-review-decision-composer";
import s from "./access.module.css";

const ownError = (code: string) => {
  const id = `accessReview.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

export function AccessReviewCyclePanel({
  activePeriod,
  onSelectPeriod,
  mode = "full",
}: {
  activePeriod: string | null;
  onSelectPeriod: (period: string | null) => void;
  mode?: "toolbar" | "body" | "full";
}) {
  const cycles = useQuery(accessReviewsQuery);
  const items = cycles.data ?? [];
  const openCycle = items.find((c) => c.state === "OPEN") ?? items[0] ?? null;
  const targetPeriod = activePeriod ?? openCycle?.period ?? "2026-Q4";
  const detail = useQuery({
    ...accessReviewDetailQuery(targetPeriod),
    enabled: activePeriod !== null || Boolean(openCycle && openCycle.state !== "UNSTARTED" && openCycle.state !== "UPCOMING"),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const startCmd = useCommand({
    run: (_: undefined, key: string) => startAccessReview(targetPeriod, key),
    invalidates: ACCESS_REVIEW_READS,
    announce: () => t("accessReview.decision.saved"),
    onSuccess: (res) => onSelectPeriod(res.summary.period),
  });

  const completeCmd = useCommand({
    run: (_: undefined, key: string) => completeAccessReview(targetPeriod, key),
    invalidates: ACCESS_REVIEW_READS,
    announce: () => t("accessReview.decision.completed"),
  });

  const downloadCsv = async () => {
    const csv = await exportAccessReviewCsv(targetPeriod);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `access-review-${targetPeriod}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (items.length === 0 && activePeriod === null) return null;

  const summary = detail.data?.summary ?? items.find((c) => c.period === targetPeriod);
  const frozenItems = detail.data?.items ?? [];
  const selectedItem = frozenItems.find((i) => i.id === selectedId) ?? null;
  const err = completeCmd.error ?? startCmd.error;

  return (
    <div className={s.stack}>
      {mode !== "body" && (
        <div className={s.actions}>
          {items.length > 0 && (
            <SelectField
              label={t("accessReview.cycle.label")}
              placeholder={t("accessReview.cycle.label")}
              value={activePeriod ?? "live"}
              onChange={(val) => onSelectPeriod(val === "live" ? null : val)}
              options={[
                { id: "live", label: t("accessReview.cycle.liveView") },
                ...items.map((c) => ({
                  id: c.period,
                  label: `${c.period} · ${t(`accessReview.cycle.state.${c.state as "OPEN" | "COMPLETE" | "UNSTARTED" | "UPCOMING"}`)}`,
                })),
              ]}
            />
          )}
          {(!summary || summary.state === "UNSTARTED") && (
            <Button size="sm" variant="primary" disabled={startCmd.isPending} onClick={() => startCmd.mutate(undefined)}>
              {t("accessReview.cycle.start")}
            </Button>
          )}
          {summary && (summary.state === "OPEN" || summary.state === "COMPLETE") && (
            <Button size="sm" variant="secondary" onClick={() => void downloadCsv()}>
              {t("accessReview.cycle.exportCsv")}
            </Button>
          )}
          {summary?.state === "OPEN" && (
            <Button size="sm" variant="primary" disabled={completeCmd.isPending} onClick={() => completeCmd.mutate(undefined)}>
              {t("accessReview.cycle.complete")}
            </Button>
          )}
        </div>
      )}

      {mode !== "toolbar" && <CommandError error={err} own={ownError} />}

      {mode !== "toolbar" && activePeriod !== null && summary && (summary.state === "OPEN" || summary.state === "COMPLETE") && (
        <>
          <Banner tone={summary.state === "COMPLETE" ? "ok" : "info"}>
            <span>
              {t("accessReview.cycle.progress", {
                decided: summary.decided_count,
                frozen: summary.frozen_count,
                reviewers: summary.reviewer_count,
              })}
            </span>
            {" · "}
            <span>{t("accessReview.cycle.due", { date: fmtDate(summary.due_at) })}</span>
          </Banner>

          <Table<AccessReviewItem>
            label={t("accessReview.table")}
            rows={frozenItems}
            rowId={(r) => r.id}
            selected={selectedItem?.id}
            onSelect={(id) => setSelectedId(id)}
            density="compact"
            columns={[
              { header: t("accessReview.person"), card: "title", cell: (r) => r.account_name },
              { header: t("accessReview.role"), card: "fact", cell: (r) => r.role_name_ko },
              {
                header: t("accessReview.scope"),
                card: "fact",
                cell: (r) => (
                  <div className={s.actions}>
                    <span>{r.scope_label}</span>
                    {r.signals.map((sig) => {
                      const sigKey = `accessReview.signal.${sig}`;
                      return (
                        <Chip key={sig} tone="warn">
                          {isMessageId(sigKey) ? t(sigKey) : sig}
                        </Chip>
                      );
                    })}
                  </div>
                ),
              },
              {
                header: t("accessReview.decision.section"),
                card: "status",
                cell: (r) =>
                  r.decision === "KEEP" ? (
                    <Chip tone="ok">{t("accessReview.decision.KEEP")}</Chip>
                  ) : r.decision === "REVOKE" ? (
                    <Chip tone="warn">
                      {r.applied_at ? t("accessReview.decision.REVOKE_APPLIED") : t("accessReview.decision.REVOKE")}
                    </Chip>
                  ) : (
                    <Chip tone="neutral">{t("accessReview.decision.undecided")}</Chip>
                  ),
              },
            ]}
          />

          {selectedItem && summary.state === "OPEN" && (
            <AccessReviewDecisionComposer
              key={selectedItem.id}
              period={targetPeriod}
              item={selectedItem}
              onClose={() => setSelectedId(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
