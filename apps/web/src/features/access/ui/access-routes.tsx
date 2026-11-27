import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { getRouteApi } from "@tanstack/react-router";
import { QueryState } from "../../../lib/react/query-state";
import { accountQuery } from "../api";
import { AccessAccountContext } from "./use-access-context";
import { BulkPage } from "./bulk-page";
import { GrantsPage } from "./grants-page";
import { PersonAccess } from "./person-access";
import { ReadinessPage } from "./readiness-page";
import { RoleEditorPage } from "./role-editor";
import { RolesPage } from "./roles-page";

const LazyAccessReviewPage = lazy(() => import("./access-review-page").then(m => ({ default: m.AccessReviewPage })));
const LazyPoliciesPage = lazy(() => import("./policies-page").then(m => ({ default: m.PoliciesPage })));
const LazyPolicyDraftPage = lazy(() => import("./policy-draft-page").then(m => ({ default: m.PolicyDraftPage })));
const LazyAccessCheckPage = lazy(() => import("./access-check-page").then(m => ({ default: m.AccessCheckPage })));

export function ReviewScreen() { return <Suspense fallback={null}><LazyAccessReviewPage /></Suspense>; }
export function PoliciesScreen() { return <Suspense fallback={null}><LazyPoliciesPage /></Suspense>; }
export function PolicyDraftScreen() { return <Suspense fallback={null}><LazyPolicyDraftPage /></Suspense>; }
export function CheckScreen() { return <Suspense fallback={null}><LazyAccessCheckPage /></Suspense>; }

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
  const { roleId } = roleRoute.useParams();
  const { tab } = roleRoute.useSearch();
  const navigate = roleRoute.useNavigate();
  return <RoleEditorPage roleId={roleId} tab={tab} onTab={(next) => void navigate({ search: { tab: next === "permissions" ? undefined : next }, replace: true })} />;
}

const grantsRoute = getRouteApi("/app/access/grants");
export function GrantsScreen() {
  return <GrantsPage role={grantsRoute.useSearch().role} />;
}

const personRoute = getRouteApi("/app/access/people/$accountId");
export function PersonScreen() {
  const { accountId } = personRoute.useParams();
  const { grant } = personRoute.useSearch();
  const navigate = personRoute.useNavigate();
  const account = useQuery(accountQuery(accountId));
  return <QueryState q={account} back={{ to: "/access/grants", label: t("access.nav.grants") }} layout="record">{data =>
    <AccessAccountContext value={data}><PersonAccess accountId={accountId} grant={grant} onGrant={(open) => void navigate({ search: { grant: open || undefined }, replace: !open })} /></AccessAccountContext>
  }</QueryState>;
}
