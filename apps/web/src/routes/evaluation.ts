// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { PAGE_SIZE, stages, type CycleStage } from "../features/evaluation/domain/cycles";
import { app, screen } from "./app";
import { createEvaluationAccess, evaluationCyclesAccess } from "./route-reads";

const register = createRoute({
  getParentRoute: () => app,
  path: "/evaluation",
  staticData: { access: evaluationCyclesAccess, floorplan: "P-01", pattern: "list-record" },
  validateSearch: (s: Record<string, unknown>): { page?: number; stage?: CycleStage } => {
    const page = Number(s.page);
    return { stage: stages.find(stage => stage === s.stage),
      page: Number.isSafeInteger(page * PAGE_SIZE) && Number.isInteger(page) && page > 0 ? page : undefined };
  },
  component: lazyRouteComponent(screen(() => import("../features/evaluation/ui/cycles")), "EvaluationCycles"),
});

const create = createRoute({
  getParentRoute: () => app,
  path: "/evaluation/new",
  staticData: { access: createEvaluationAccess, floorplan: "P-04", pattern: "form" },
  component: lazyRouteComponent(screen(() => import("../features/evaluation/ui/create-cycle")), "CreateEvaluationCycle"),
});

export const evaluationRoutes = [register, create] as const;
