// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadLayout } from "../../../ui/skeleton/skeleton";
import { ApiError, servedAuthzApplies } from "../../authz/api";
import { streamAccessQuery } from "../api";

export function RestrictedAccessGate({ children, layout }: { children: ReactNode; layout: ReadLayout }) {
  const enabled = servedAuthzApplies();
  const access = useQuery({ ...streamAccessQuery, enabled });
  const unavailable = access.error instanceof ApiError && access.error.status === 404;
  const refused = !enabled || unavailable || access.isSuccess && !access.data.events && !access.data.access_events;
  const q = refused ? { ...access, data: undefined, error: new ApiError(403, "access_denied", "", [], undefined, false) }
    : access.isError ? { ...access, data: undefined } : access;
  return <QueryState q={q} layout={layout} need={{ servedCapability: "restricted_audit_stream" }}>{() => children}</QueryState>;
}
