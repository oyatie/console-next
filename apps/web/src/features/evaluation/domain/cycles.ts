// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

export type CycleStage = components["schemas"]["EvaluationCycleStage"];
export const stages = ["DRAFT", "OPEN", "CALIBRATION", "FINALIZED", "ARCHIVED"] as const satisfies readonly CycleStage[];
export const PAGE_SIZE = 20;
