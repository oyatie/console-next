// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { CrashScreen } from "./crash-screen";
import { QueryState } from "./query-state";

/** Fetch uses TypeError too; unrelated TypeErrors still need the programming-error screen. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const transport = error instanceof TypeError && /^(Failed to fetch|Load failed|fetch failed|NetworkError when attempting to fetch resource\.?)$/.test(error.message)
    || error instanceof DOMException && (error.name === "NetworkError" || error.name === "TimeoutError" || error.name === "AbortError");
  if (!(error instanceof ApiError) && !transport) return <CrashScreen error={error} />;
  return <div className="page"><QueryState q={{ isPending: false, error, data: undefined, refetch: () => router.invalidate() }}>{() => null}</QueryState></div>;
}
