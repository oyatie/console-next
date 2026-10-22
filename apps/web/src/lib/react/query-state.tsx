import type { ReactNode } from "react";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { failureText } from "../refusal";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { EmptyState } from "../../ui/empty-state";
import { SupportReference } from "./support-reference";
import { Denied } from "./denied";

type Q<T> = { isPending: boolean; error: unknown; data: T | undefined; refetch: () => unknown };

/**
 * Loading / denied / error / empty / data — every screen goes through this. A failed background
 * refetch (focus or polling) keeps the loaded data and anything typed into it on screen, with a notice.
 */
export function QueryState<T>({ q, empty, children, own }: { q: Q<T>; own?: (code: string) => string | undefined; empty?: (d: T) => ReactNode | null; children: (d: T) => ReactNode }) {
  if (q.isPending) return <div className="state muted" role="status">{t("common.loading")}</div>;
  if (q.error && q.data === undefined) {
    const e = q.error instanceof ApiError ? q.error : null;
    if (e?.status === 403) return <Denied error={e} reason={own?.(e.code)} />;
    return (
      <EmptyState
        alert
        title={t("common.loadFailed.title")}
        reason={<>{failureText(q.error, own)}{e?.operationId && <> · <span className="code">{e.operationId}</span></>}</>}
        actions={<Button onClick={() => q.refetch()}>{t("common.retry")}</Button>}
        meta={<SupportReference reference={e?.supportRef} at={e?.supportRefAt} />}
      />
    );
  }
  const d = q.data as T;
  return (
    <>
      {q.error ? <Banner tone="danger" live="polite">{t("common.loadFailed.title")} · {failureText(q.error, own)}<SupportReference reference={q.error instanceof ApiError ? q.error.supportRef : undefined} at={q.error instanceof ApiError ? q.error.supportRefAt : undefined} /></Banner> : null}
      {empty?.(d) ?? children(d)}
    </>
  );
}
