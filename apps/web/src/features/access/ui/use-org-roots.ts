import { useQuery } from "@tanstack/react-query";
import { orgStructureRef } from "../../../reference/entity/api";
import type { OrgNode } from "../domain/scope";

/** The entity > workplace tree every scope is named and counted from (empty until it loads). */
export const useOrgRoots = () => (useQuery(orgStructureRef).data?.entities ?? []) as OrgNode[];
