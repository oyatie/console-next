// SPDX-License-Identifier: LicenseRef-Proprietary
import type { StaticDataRouteOption } from "@tanstack/react-router";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal, type AccessRequirement } from "../reference/authz/domain/access";

import type { MessageId } from "@console/i18n";
import { get } from "../lib/query";

type Destination = "/settings/company-domain" | "/people/numbering" | "/people/job-titles" | "/people/roster-fields" | "/people/period-locks";
/** Route metadata owns access; the route contract test pins each shared read path. */
export const SETTINGS_VIEWS = [
  { to: "/settings/company-domain", label: "shell.settings.domain", summary: { ...get("/api/v1/tenant/company-domain/request"), format: "domain" } },
  { to: "/people/numbering", label: "identifiers.numbering.title", summary: { ...get("/api/v1/employee-number-rules"), format: "numbering" } },
  { to: "/people/job-titles", label: "shell.settings.titles", summary: { ...get("/api/v1/job-titles"), format: "titles" } },
  { to: "/people/roster-fields", label: "rosterFields.title", summary: { ...get("/api/v1/roster-fields"), format: "rosterFields" } },
  { to: "/people/period-locks", label: "periodLocks.title", summary: { ...get("/api/v1/period-locks", { params: { query: { limit: 200 } } }), format: "periods" } },
] as const satisfies readonly { to: Destination; label: MessageId; summary: object }[];
export type SettingsView = (typeof SETTINGS_VIEWS)[number];
type Route = { options: { path?: string; staticData?: StaticDataRouteOption } };

function servedViews(routes: readonly Route[]) {
  return SETTINGS_VIEWS.flatMap(view => {
    const need = routes.find(route => route.options.path === view.to)?.options.staticData?.access;
    return need && need !== "signed-in" ? [{ ...view, need }] : [];
  });
}

export function settingsRequirement(routes: readonly Route[]): AccessRequirement {
  return { destinations: servedViews(routes).map(view => view.need) };
}

export function settingsViews(routes: readonly Route[], access: AccessEffective | undefined) {
  return access ? servedViews(routes).filter(view => accessRefusal(access, view.need) === null) : [];
}
