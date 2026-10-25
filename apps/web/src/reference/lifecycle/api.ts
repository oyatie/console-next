// SPDX-License-Identifier: LicenseRef-Proprietary
import { get, queryPath } from "../../lib/query";

export const lifecycleCasesQuery = (id: string) => get("/api/v1/employees/{id}/lifecycle-cases", { params: { path: { id } } });
export const lifecycleCaseQuery = (id: string) => get("/api/v1/lifecycle-cases/{id}", { params: { path: { id } } });
/** Case decisions change the trail and inbox; employee facts follow their own live topics. */
export const LIFECYCLE_CASE_READS = [queryPath(get("/api/v1/lifecycle-cases/{id}")), queryPath(get("/api/v1/employees/{id}/lifecycle-cases")), queryPath(get("/api/v1/me/action-inbox"))];
