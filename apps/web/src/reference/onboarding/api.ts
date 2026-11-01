// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";

export const modulesQuery = { ...get("/api/v1/onboarding/modules"), retry: false, staleTime: Infinity };
