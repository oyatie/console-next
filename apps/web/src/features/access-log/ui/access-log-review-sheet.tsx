// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Receipt } from "../../../ui/receipt/receipt";
import { Sheet } from "../../../ui/sheet/sheet";
import { accessLogReviewQuery } from "../api";
import type { ReviewComposerMode } from "./access-log-review-composer";

const AccessLogReviewComposer = lazy(() =>
  import("./access-log-review-composer").then(m => ({ default: m.AccessLogReviewComposer })),
);

function formatFindingSummary(finding: Record<string, unknown>): string {
  const disposition = typeof finding.disposition === "string" ? finding.disposition : "";
  const outcome = typeof finding.outcome === "string" ? finding.outcome : "";
  const note = typeof finding.note === "string" ? finding.note : "";
  return [disposition, outcome, note].filter(Boolean).join(" · ") || "—";
}

export function AccessLogReviewSheet({
  period,
  initialEventId,
  onClose,
}: {
  period: string;
  initialEventId?: string | null;
  onClose: () => void;
}) {
  const reviewQuery = useQuery(accessLogReviewQuery(period));
  const [composerMode, setComposerMode] = useState<ReviewComposerMode | null>(initialEventId ? "record" : null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);

  return (
    <>
      <Sheet
        open={!composerMode}
        title={t("accessLog.review.title", { period })}
        onClose={onClose}
        consequence={null}
        actions={
          <Button onClick={onClose}>{t("uiSheet.close")}</Button>
        }
      >
        {receiptMessage && <Receipt state="recorded" message={receiptMessage} />}
        <QueryState q={reviewQuery} compact>
          {review => {
            const status = review.reviewed_at
              ? "completed"
              : review.started_at
                ? "inProgress"
                : "notStarted";
            const statusTone = status === "completed" ? "ok" : status === "inProgress" ? "warn" : "neutral";
            return (
              <>
                <Card title={t("accessLog.review.open")}>
                  <KeyValue
                    density="dense"
                    items={[
                      {
                        key: "status",
                        label: t("accessLog.outcome"),
                        value: <Chip tone={statusTone}>{t(`accessLog.review.status.${status}`)}</Chip>,
                      },
                      { key: "scope", label: t("accessLog.review.scope"), value: review.scope },
                      { key: "due", label: t("accessLog.review.due"), value: fmtDateTime(review.due) },
                      ...(review.reviewed_at
                        ? [{ key: "reviewed", label: t("accessLog.review.reviewedAt"), value: fmtDateTime(review.reviewed_at) }]
                        : []),
                    ]}
                  />
                  <div>
                    {!review.started_at && (
                      <Button variant="primary" onClick={() => setComposerMode("start")}>
                        {t("accessLog.review.start")}
                      </Button>
                    )}
                    {review.started_at && !review.reviewed_at && (
                      <>
                        <Button onClick={() => setComposerMode("record")}>
                          {t("accessLog.review.recordFinding")}
                        </Button>
                        <Button variant="primary" onClick={() => setComposerMode("complete")}>
                          {t("accessLog.review.complete")}
                        </Button>
                      </>
                    )}
                  </div>
                </Card>
                <Card title={t("accessLog.review.findings", { count: review.findings.length })}>
                  {review.findings.length === 0 ? (
                    <EmptyState title={t("accessLog.review.noFindings")} reason={null} />
                  ) : (
                    <KeyValue
                      density="dense"
                      items={review.findings.map((finding, index) => ({
                        key: `finding-${index}`,
                        label: `#${index + 1}`,
                        value: formatFindingSummary(finding),
                      }))}
                    />
                  )}
                </Card>
              </>
            );
          }}
        </QueryState>
      </Sheet>
      {composerMode && (
        <Suspense fallback={null}>
          <AccessLogReviewComposer
            period={period}
            mode={composerMode}
            initialEventId={initialEventId}
            onClose={() => setComposerMode(null)}
            onDone={(_review, message) => {
              setComposerMode(null);
              setReceiptMessage(message);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
