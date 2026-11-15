// SPDX-License-Identifier: LicenseRef-Proprietary
import { cursorPages } from "../../../lib/query";

/** The month grid, 100 people a page by keyset (useInfiniteQuery). */
export const monthGridPages = (month: string, workplace_id?: string, unit_id?: string) => cursorPages("/api/v1/attendance/month", { month, workplace_id, unit_id, limit: 100 });
