// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy } from "react";
import { chunk } from "../../../lib/chunk-guard";

export const BulkSheet = lazy(() => chunk(import("./bulk-sheet")).then(m => ({ default: m.BulkSheet })));
export const RosterUnitPanel = lazy(() => chunk(import("./roster-unit-panel")).then(m => ({ default: m.RosterUnitPanel })));
