// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import type { ReadBack } from "../../../lib/react/denied";
import { PageHead } from "../../../ui/page-head/page-head";
import { ReadSkeleton, type ReadLayout } from "../../../ui/skeleton/skeleton";
import { accessRefusal, type AccessRequirement } from "../domain/access";
import { ApiError, myAccessQuery } from "../api";

/** Form routes wait for their own grant, independently of onboarding and legacy role names. */
export function AccessGate({ children, layout = "form", ...need }: AccessRequirement & { children: ReactNode; layout?: ReadLayout }) {
  const access = useQuery(myAccessQuery);
  const view = queryView(access);
  const code = access.data && view !== "denied" && view !== "not-found" ? accessRefusal(access.data, need) : null;
  const reference = access.error instanceof ApiError ? access.error.operationId : undefined;
  const q = code ? { ...access, error: new ApiError(403, code, "", [], reference, false) } : access;
  return <QueryState q={q} layout={layout} need={need}>{() => children}</QueryState>;
}

/** The leaf route decides before its page (or a nested sheet's parent page) mounts. */
export function RouteGuard({ children }: { children: ReactNode }) {
  const need = useMatches({ select: matches => matches.at(-1)?.staticData.access });
  if (!need) throw new Error("Route must declare staticData.access");
  return <Suspense fallback={<ReadSkeleton layout="list" />}>
    {need === "signed-in" ? children : <AccessGate {...need} layout="list">{children}</AccessGate>}
  </Suspense>;
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
