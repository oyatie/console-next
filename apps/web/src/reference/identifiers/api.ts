// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";

/** The numbering catalog shared by import and identifier settings. */
export const rulesQuery = get("/api/v1/employee-number-rules");
