// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../../lib/query";

export const employeeQuery = (id: string) => get("/api/v1/employees/{id}", { params: { path: { id } } });
