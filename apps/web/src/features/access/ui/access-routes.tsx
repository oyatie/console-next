import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { getRouteApi } from "@tanstack/react-router";
import { BulkPage } from "./bulk-page";
import { GrantsPage } from "./grants-page";
import { PersonAccess } from "./person-access";
import { ReadinessPage } from "./readiness-page";
import { RoleEditorPage } from "./role-editor";
import { RolesPage } from "./roles-page";

// The slice's screens as route components (routes/access.ts loads this module lazily).
export const RolesScreen = RolesPage;
export function BulkScreen() { return <AccessGate domain="access" level="edit"><BulkPage /></AccessGate>; }
export const ReadyScreen = ReadinessPage;

const newRoute = getRouteApi("/app/access/roles/new");
export function RoleNewScreen() {
  const { copy } = newRoute.useSearch();
  return <AccessGate domain="access" level="edit" tenant><RoleEditorPage copy={copy} /></AccessGate>;
}

const roleRoute = getRouteApi("/app/access/roles/$roleId");
export function RoleScreen() {
  return <RoleEditorPage roleId={roleRoute.useParams().roleId} />;
}

const grantsRoute = getRouteApi("/app/access/grants");
export function GrantsScreen() {
  return <GrantsPage role={grantsRoute.useSearch().role} />;
}

const personRoute = getRouteApi("/app/access/people/$accountId");
export function PersonScreen() {
  return <PersonAccess accountId={personRoute.useParams().accountId} grant={personRoute.useSearch().grant} />;
}
