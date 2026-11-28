// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../lib/query";

import { PAGE_SIZE, type CycleStage } from "./domain/cycles";

type Schema = components["schemas"];
export type CreateCycle = Schema["CreateEvaluationCycleRequest"];
export const cyclesQuery = (stage: CycleStage | undefined, page: number) => get("/api/v1/evaluation/cycles", {
  params: { query: { stage, offset: page * PAGE_SIZE, limit: PAGE_SIZE } },
});

export async function createCycle(body: CreateCycle, key: string) {
  try {
    await unwrap(api.POST("/api/v1/evaluation/cycles", { params: { header: { "Idempotency-Key": key } }, body }));
  } catch (error) {
    // The command ledger confirms this exact intent committed even if the original response was lost.
    if (!(error instanceof ApiError && error.status === 409 && error.code === "command_applied")) throw error;
  }
}
