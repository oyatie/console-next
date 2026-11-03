// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";
import type { components } from "@console/api";

type Modules = components["schemas"]["OnboardingModules"];
export type ModuleKey = Modules[number]["key"];
export const APPROVALS_MODULE = "approvals" satisfies ModuleKey;
export const PAYROLL_MODULE = "payroll" satisfies Modules[number]["key"];
export const moduleReady = (modules: Modules | null | undefined, key: ModuleKey) => modules?.some(module => module.key === key && module.ready) ?? false;

export const modulesQuery = { ...get("/api/v1/onboarding/modules"), retry: false, staleTime: Infinity };
