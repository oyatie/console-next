// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, peopleDataHealthApi } from "@console/api";
import { read } from "../../../lib/query";
import type { DataHealthCategory } from "../domain/data-health";

export type { DataHealthCategory };

const DATA_HEALTH_LIMIT = 50;

export const peopleDataHealthQuery = (category?: DataHealthCategory, limit = DATA_HEALTH_LIMIT) => ({
  ...read(
    "/api/v1/hr/people/data-health",
    () => peopleDataHealthApi(api).getPeopleDataHealth({ ...(category ? { category } : {}), limit }),
    { category: category ?? null, limit },
  ),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
});
