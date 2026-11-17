// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../../lib/query";

/** Every entity with its registrations and workplaces embedded. */
export const entitiesRef = get("/api/v1/legal-entities");
/** Tenant-wide workplace read, using the same scoped, dated record projection. */
export const assignmentsRef = (employeeId: string) => get("/api/v1/employment-assignments", { params: { query: { employee_id: employeeId } } });
