// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, hrWaterfallApi, unwrap } from "@console/api";
import { get, read } from "../../../lib/query";

const DATA_HEALTH_PAGE_LIMIT = 200;
const ACTIVE_STATUSES: ("ACTIVE" | "ON_LEAVE" | "UNKNOWN" | "PRE_HIRE")[] = ["ACTIVE", "ON_LEAVE", "UNKNOWN", "PRE_HIRE"];
const FACET_STATUSES: ("ACTIVE" | "ON_LEAVE" | "UNKNOWN")[] = ["ACTIVE", "ON_LEAVE", "UNKNOWN"];

export const dataHealthEmployeesQuery = get("/api/v1/employees", {
  params: { query: { status: ACTIVE_STATUSES, limit: DATA_HEALTH_PAGE_LIMIT, offset: 0 } },
});

export const dataHealthFacetsQuery = (contractEndingBefore: string) =>
  get("/api/v1/employees/facets", {
    params: {
      query: {
        status: FACET_STATUSES,
        contract_ending_before: contractEndingBefore,
      },
    },
  });

export const dataHealthRegisterFactsQuery = {
  ...read(
    "/api/v1/employees/register-facts/query",
    () => hrWaterfallApi(api).queryRegisterFacts({ register_review_required: true, limit: DATA_HEALTH_PAGE_LIMIT }),
    { register_review_required: true, limit: DATA_HEALTH_PAGE_LIMIT },
  ),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
};

export const dataHealthLatestImportRunsQuery = {
  ...read(
    "/api/v1/employee-import-runs",
    () => unwrap(api.GET("/api/v1/employee-import-runs", { params: { query: { limit: 5 } } })),
    { limit: 5, scope: "data-health" },
  ),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
};

export const dataHealthUnplacedQuery = {
  ...get("/api/v1/employees/import/unplaced", { params: { query: { limit: DATA_HEALTH_PAGE_LIMIT } } }),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
};
