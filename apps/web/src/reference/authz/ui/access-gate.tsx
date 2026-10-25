// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import type { ReadBack } from "../../../lib/react/denied";
import { PageHead } from "../../../ui/page-head/page-head";
import type { ReadLayout } from "../../../ui/skeleton/skeleton";
import { accessRefusal, type Requirement } from "../domain/access";
import { ApiError, myAccessQuery } from "../api";

/** Form routes wait for their own grant, independently of onboarding and legacy role names. */
export function AccessGate({ children, layout = "form", ...requirement }: Requirement & { children: ReactNode; layout?: ReadLayout }) {
  const access = useQuery(myAccessQuery);
  const view = queryView(access);
  const code = access.data && view !== "denied" && view !== "not-found" ? accessRefusal(access.data, requirement) : null;
  const reference = access.error instanceof ApiError ? access.error.operationId : undefined;
  const q = code ? { ...access, error: new ApiError(403, code, "", [], reference, false) } : access;
  return <QueryState q={q} layout={layout}>{() => children}</QueryState>;
}

/** A refusal replaces the whole page body; loading and transient failures keep its controls mounted. */
export function PageReadGate({ q, children, title, recovery, head, ...state }: { q: ReadState; children: ReactNode; title?: string; recovery?: ReactNode; head?: (available: boolean) => ReactNode; back?: ReadBack; removed?: string; own?: (code: string) => string | undefined }) {
  const view = queryView(q);
  const [refusal, setRefusal] = useState<unknown>(null);
  const refused = view === "denied" || view === "not-found";
  if (refused && refusal !== q.error) setRefusal(q.error);
  if (view === "ready" && !q.isPlaceholderData && refusal) setRefusal(null);
  if (!refused && !(q.isPlaceholderData && refusal)) return <>{head?.(true)}{children}</>;
  return <>
    {head?.(false)}
    {title && <PageHead title={title} />}
    {recovery}
    <QueryState q={{ ...q, error: refused ? q.error : refusal }} {...state}>{() => null}</QueryState>
  </>;
}
