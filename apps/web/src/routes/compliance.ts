// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen } from "./app";
import { complianceCatalogAccess, evidenceBindingsAccess, manageComplianceAccess, proposeEvidenceAccess } from "./route-reads";

const catalog = createRoute({
  getParentRoute: () => app, path: "/compliance",
  staticData: { access: complianceCatalogAccess, floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/compliance/ui/catalog")), "ComplianceCatalog"),
});
const create = createRoute({
  getParentRoute: () => app, path: "/compliance/new",
  staticData: { access: manageComplianceAccess, floorplan: "P-04", pattern: "form" },
  component: lazyRouteComponent(screen(() => import("../features/compliance/ui/catalog-form")), "ComplianceCatalogForm"),
});
const evidence = createRoute({
  getParentRoute: () => app, path: "/compliance/evidence",
  staticData: { access: evidenceBindingsAccess, floorplan: "P-03", pattern: "worklist" },
  component: lazyRouteComponent(screen(() => import("../features/compliance/ui/evidence")), "EvidenceWorklist"),
});
const propose = createRoute({
  getParentRoute: () => app, path: "/compliance/evidence/new",
  staticData: { access: proposeEvidenceAccess, floorplan: "P-04", pattern: "form" },
  component: lazyRouteComponent(screen(() => import("../features/compliance/ui/evidence-proposal")), "EvidenceProposal"),
});
export const complianceRoutes = [catalog, create, evidence, propose] as const;
