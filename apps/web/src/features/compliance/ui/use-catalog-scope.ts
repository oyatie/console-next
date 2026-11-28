// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { authzQuery } from "../../../reference/authz/api";
import { branchesQuery } from "../../../reference/org/api";

export function useCatalogScope(mode: "read" | "manage") {
  const authz = useQuery(authzQuery);
  const feature = mode === "read" ? "served_compliance_catalog" : "served_compliance_catalog_manage";
  const cap = authz.isError ? undefined : authz.data?.capabilities.find(item => item.feature === feature && item.permission !== "request_only");
  const branches = useQuery({ ...branchesQuery, enabled: !!cap });
  const names = new Map(branches.data?.map(b => [b.id, b.name]));
  const orgWide = !!cap?.org_wide && authz.data?.branch_scope.kind === "all";
  const ids = cap?.branch_scope.kind === "branches" ? cap.branch_scope.branches ?? [] : [...names.keys()];
  return { orgWide, ids, names, branches, cap };
}
