import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { getRouteApi, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { QueryState } from "../../../lib/react/query-state";
import { entityQuery } from "../api";
import { EntityList } from "./entity-list";
import { EntityBulkPage } from "./entity-bulk-page";

// The slice's screens as route components (routes/entity.ts loads this module lazily).
const listRoute = getRouteApi("/app/org");
export function EntitiesScreen() {
  const { bulk } = listRoute.useSearch();
  return bulk ? <AccessGate domain="org" level="edit" tenant><EntityBulkPage key={bulk} paste={bulk === "paste"} /></AccessGate> : <EntityList />;
}

/** Keep the bulk entry links while registration uses the legal-entity workspace. */
const bulkRoute = getRouteApi("/app/org/entities/bulk");
export function EntityBulkScreen() {
  const { mode } = bulkRoute.useSearch();
  return <Navigate to="/org" search={{ tab: "entities", bulk: mode }} hash replace />;
}

const wpRoute = getRouteApi("/app/org/entities/$id/workplaces/new");
/** add workplace is a sheet over company structure, opened on its legal entity (S5-create); this old address leads there. */
export function NewWorkplaceScreen() {
  const { id } = wpRoute.useParams();
  const q = useQuery(entityQuery(id));
  return <QueryState q={q}>{() => <Navigate to="/org" search={{ sel: id, act: "wp-create" }} replace />}</QueryState>;
}
