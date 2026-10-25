import { useState, type ReactNode } from "react";
import s from "./query-state.module.css";
import { useOnline } from "./use-online";
import { ApiError } from "@console/api";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { readFailureText } from "../refusal";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { EmptyState } from "../../ui/empty-state";
import { Denied, type ReadBack } from "./denied";
import { ReadSkeleton, Skeleton, type ReadLayout } from "../../ui/skeleton/skeleton";
import { queryView, type ReadState } from "./query-view";
import { ReadReference } from "./read-reference";

/**
 * Invariant: page chrome (head, tabs, toolbar and the control just used) stays above read boundaries.
 * Refetches keep rendered content and focus; only a first load may show a layout placeholder.
 * Filter/date/search reads use keepPreviousData; the retained region is busy until the answer lands.
 */
export function QueryState<T>({ q, empty, children, own, loading, layout, back, removed, inline, keepOnLoss }: { q: ReadState<T>; own?: (code: string) => string | undefined; empty?: (d: T) => ReactNode | null; children: (d: T) => ReactNode; loading?: ReactNode; layout?: ReadLayout; back?: ReadBack; removed?: string; inline?: boolean; keepOnLoss?: boolean }) {
  const online = useOnline();
  const answer = queryView(online ? q : { ...q, fetchStatus: "paused" });
  const error = q.error instanceof ApiError ? q.error : null;
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  if ((answer === "denied" || answer === "not-found") && error && refusal !== error) setRefusal(error);
  if (answer === "ready" && !q.isPlaceholderData && refusal) setRefusal(null);
  // TanStack can offer its last successful answer again after a refused key; wait for a new server answer.
  const suppressed = q.isPlaceholderData && refusal !== null;
  const view = q.isPlaceholderData && refusal ? refusal.status === 403 ? "denied" : "not-found" : answer;
  const e = suppressed ? refusal : error;
  const retry = <Button onClick={() => q.refetch()}>{t("common.retry")}</Button>;
  const offline = view === "offline";
  const lost = !suppressed && keepOnLoss && q.data !== undefined && (view === "denied" || view === "not-found");
  const reference = <ReadReference error={q.error} />;
  const content = q.data !== undefined && (lost || view === "ready" || view === "stale" || offline) ? empty?.(q.data) ?? children(q.data) : null;
  const [retained, setRetained] = useState<{ data: T | undefined; content: ReactNode }>({ data: undefined, content: null });
  if (q.isPlaceholderData && !suppressed && retained.data !== q.data) setRetained({ data: q.data, content });
  const waiting = view === "failed" || view === "loading" || (offline && q.data === undefined);
  if ((!q.isPlaceholderData || suppressed) && !waiting && retained.data !== undefined) setRetained({ data: undefined, content: null });
  const retainedRefetch = retained.content !== null && waiting;
  const notice = <Banner tone="warn" live="polite" actions={lost ? undefined : retry}>
    {lost ? t(view === "not-found" ? "live.notice.gone" : "live.notice.no_access") : <>
      {inline ? own?.(e?.code ?? "") ?? readFailureText(q.error) : t(offline ? "common.read.offline" : "common.read.stale")}
      {!inline && q.error ? <> · {readFailureText(q.error, own)}</> : null}
      {reference}
    </>}
  </Banner>;
  if (inline && q.error && !lost) return notice;
  if (view === "denied" && !lost) return <Denied error={e} reason={e ? own?.(e.code) : undefined} back={back} />;
  if (view === "not-found" && !lost) return <div className="page"><EmptyState title={t("common.read.notFound.title")} reason={q.data !== undefined && removed ? removed : e && own?.(e.code) || t("common.read.notFound.reason")} actions={<Link to={back?.to ?? "/"} className="btn">{back?.label ?? t("common.notFound.action")}</Link>} /></div>;
  if (view === "loading" && !retainedRefetch) return loading ?? (layout ? <ReadSkeleton layout={layout} /> : <Skeleton bones={["line"]} label={t("common.loading")} />);
  if ((view === "failed" && !retainedRefetch) || (offline && q.data === undefined && !retainedRefetch)) {
    return (
      <EmptyState
        alert
        title={t(offline ? "common.read.offline" : "common.loadFailed.title")}
        reason={readFailureText(q.error, own)}
        actions={retry}
        meta={reference}
      />
    );
  }
  if (view === "ready" && !q.isPlaceholderData && (content == null || typeof content === "boolean")) return null;
  return (
    <div className={s.region} data-read-region aria-busy={q.isPlaceholderData || (retainedRefetch && view === "loading") || undefined}>
      {lost || (retainedRefetch && view === "failed") || view === "stale" || offline ? notice : null}
      {keepOnLoss ? <div inert={lost || undefined}>{retainedRefetch ? retained.content : content}</div> : retainedRefetch ? retained.content : content}
    </div>
  );
}
