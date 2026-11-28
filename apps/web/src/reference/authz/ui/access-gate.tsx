// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import type { ReadBack } from "../../../lib/react/denied";
import { PageHead } from "../../../ui/page-head/page-head";
import { ReadSkeleton, type ReadLayout } from "../../../ui/skeleton/skeleton";
import { accessRefusal, type AccessRequirement, type ServedCapability } from "../domain/access";
import { RestrictedAccessGate } from "../../audit/ui/restricted-access-gate";
import { canUseServed } from "./use-documents-served";
import { ApiError, authzApplies, authzQuery, myAccessQuery } from "../api";
import { moduleReady, modulesQuery, type ModuleKey } from "../../onboarding/api";

function ModuleGate({ children, module }: { children: ReactNode; module: ModuleKey }) {
  const modules = useQuery(modulesQuery);
  const q = modules.data && !moduleReady(modules.data, module)
    ? { ...modules, error: new ApiError(403, "module_disabled", "", [], undefined, false) }
    : modules;
  return <QueryState q={q} layout="list">{() => children}</QueryState>;
}

/** Form routes wait for their own grant, independently of onboarding and legacy role names. */
export function AccessGate({ children, layout = "form", ...need }: AccessRequirement & { children: ReactNode; layout?: ReadLayout }) {
  if ("servedCapability" in need && need.servedCapability === "restricted_audit_stream") return <RestrictedAccessGate layout={layout}>{children}</RestrictedAccessGate>;
  if ("servedCapability" in need) return <ServedAccessGate feature={need.servedCapability} layout={layout}>{children}</ServedAccessGate>;
  return <EffectiveAccessGate {...need} layout={layout}>{children}</EffectiveAccessGate>;
}

function ServedAccessGate({ children, layout, feature }: { children: ReactNode; layout: ReadLayout; feature: ServedCapability }) {
  const enabled = authzApplies();
  const access = useQuery({ ...authzQuery, enabled });
  const denied = !enabled || (access.isSuccess && !canUseServed(feature, access.data.capabilities));
  const q = denied ? { ...access, error: new ApiError(403, "access_denied", "", [], undefined, false) }
    : access.isError ? { ...access, data: undefined } : access;
  return <QueryState q={q} layout={layout} need={{ servedCapability: feature }}>{() => children}</QueryState>;
}

function EffectiveAccessGate({ children, layout, ...need }: Exclude<AccessRequirement, { servedCapability: string }> & { children: ReactNode; layout: ReadLayout }) {
  const access = useQuery(myAccessQuery);
  const view = queryView(access);
  const code = access.data && view !== "denied" && view !== "not-found" ? accessRefusal(access.data, need) : null;
  const reference = access.error instanceof ApiError ? access.error.operationId : undefined;
  const q = code ? { ...access, error: new ApiError(403, code, "", [], reference, false) } : access;
  return <QueryState q={q} layout={layout} need={need}>{() => children}</QueryState>;
}

/** Warm the signed-in user's capability decision alongside the screen's effective access check. */
function PreloadUserCapabilities() {
  useQuery({ ...authzQuery, enabled: authzApplies() });
  return null;
}

/** The leaf route decides before its page (or a nested sheet's parent page) mounts. */
export function RouteGuard({ children }: { children: ReactNode }) {
  const route = useMatches({ select: matches => matches.at(-1)?.staticData });
  const need = route?.access;
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    if (route?.floorplan) main?.setAttribute("data-floorplan", route.floorplan);
    else main?.removeAttribute("data-floorplan");
  }, [route?.floorplan]);
  if (!need) throw new Error("Route must declare staticData.access");
  const page = route.module ? <ModuleGate module={route.module}>{children}</ModuleGate> : children;
  return <Suspense fallback={<ReadSkeleton layout="list" />}>
    {route?.preloadUserCapabilities && <PreloadUserCapabilities />}
    {need === "signed-in" ? page : <AccessGate {...need} layout="list">{page}</AccessGate>}
  </Suspense>;
}

/** A refusal replaces the whole page body; loading and transient failures keep its controls mounted. */
export function PageReadGate({ q, children, title, recovery, head, keepOnLoss, ...state }: { q: ReadState; children: ReactNode; title?: string; recovery?: ReactNode; head?: (available: boolean) => ReactNode; back?: ReadBack; removed?: string; own?: (code: string) => string | undefined; keepOnLoss?: boolean }) {
  const view = queryView(q);
  const [refusal, setRefusal] = useState<unknown>(null);
  const refused = view === "denied" || view === "not-found";
  if (refused && refusal !== q.error) setRefusal(q.error);
  if (view === "ready" && !q.isPlaceholderData && refusal) setRefusal(null);
  const lost = Boolean(keepOnLoss && q.data !== undefined && (refused || (q.isPlaceholderData && refusal)));
  if ((!refused && !(q.isPlaceholderData && refusal)) || lost) return <>{head?.(true)}{children}</>;
  return <>
    {head?.(false)}
    {title && <PageHead title={title} />}
    {recovery}
    <QueryState q={{ ...q, error: refused ? q.error : refusal }} {...state}>{() => null}</QueryState>
  </>;
}
