import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, flag, screen, str } from "./app";

const load = () => import("../features/entity/ui/entity-routes");
const KINDS = ["CORPORATION", "INDIVIDUAL", "ID_NUMBER_ORG"] as const;
type Kind = (typeof KINDS)[number];
// `add` opens the quick add entity sheet over the list (the chart's root box opens the same sheet).
const entities = createRoute({
  getParentRoute: () => app,
  path: "/org/entities",
  validateSearch: (s: Record<string, unknown>): { add?: boolean; as_of?: string; known_at?: string; bulk?: "paste" | "import" } => ({ add: flag(s.add), as_of: str(s.as_of), known_at: str(s.known_at), bulk: s.bulk === "paste" || s.bulk === "import" ? s.bulk : undefined }),
  component: lazyRouteComponent(screen(load), "EntitiesScreen"),
});
// `kind` and `name` carry what the quick sheet already chose into the full certificate wizard.
const newEntity = createRoute({
  getParentRoute: () => app,
  path: "/org/entities/new",
  validateSearch: (s: Record<string, unknown>): { kind?: Kind; name?: string } => ({ kind: KINDS.includes(s.kind as Kind) ? (s.kind as Kind) : undefined, name: str(s.name) }),
  component: lazyRouteComponent(screen(load), "NewEntityScreen"),
});
const entity = createRoute({
  getParentRoute: () => app,
  path: "/org/entities/$id",
  // `wp` opens the workplaces tab with that workplace selected (setup and Home link straight to it). `reissue` opens the
  // certificate reissue sheet for that registration (its one host; the workplace panel on the chart links here).
  validateSearch: (s: Record<string, unknown>): { wp?: string; as_of?: string; known_at?: string; tab?: "history"; reissue?: string } => ({ wp: str(s.wp), as_of: str(s.as_of), known_at: str(s.known_at), tab: s.tab === "history" ? "history" : undefined, reissue: str(s.reissue) }),
  component: lazyRouteComponent(screen(load), "EntityScreen"),
});
const newWorkplace = createRoute({ getParentRoute: () => app, path: "/org/entities/$id/workplaces/new", component: lazyRouteComponent(screen(load), "NewWorkplaceScreen") });

const entityBulk = createRoute({ getParentRoute: () => app, path: "/org/entities/bulk", validateSearch: (s: Record<string, unknown>): { mode: "paste" | "import" } => ({ mode: s.mode === "paste" ? "paste" : "import" }), component: lazyRouteComponent(screen(load), "EntityBulkScreen") });

export const entityRoutes = [entityBulk, entities, newEntity, entity, newWorkplace];
