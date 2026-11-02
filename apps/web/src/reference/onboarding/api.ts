// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";
import type { components } from "@console/api";

type Modules = components["schemas"]["OnboardingModules"];
export const PAYROLL_MODULE = "payroll" satisfies Modules[number]["key"];
export const moduleReady = (modules: Modules | null | undefined, key: Modules[number]["key"]) => modules?.some(module => module.key === key && module.ready) ?? false;

export const modulesQuery = { ...get("/api/v1/onboarding/modules"), retry: false, staleTime: Infinity };
