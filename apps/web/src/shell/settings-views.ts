// SPDX-License-Identifier: LicenseRef-Proprietary
import type { StaticDataRouteOption } from "@tanstack/react-router";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal, type AccessRequirement } from "../reference/authz/domain/access";

import type { MessageId } from "@console/i18n";
import { get } from "../lib/query";
import { routeReads } from "../routes/route-reads";

type Destination = "/settings/company-domain" | "/people/numbering" | "/people/job-titles" | "/people/period-locks";
const readPath = <P extends Destination>(to: P) => routeReads[to].reads[0].slice(4) as typeof routeReads[P]["reads"][0] extends `GET ${infer Path}` ? Path : never;
/** Route metadata owns access; summaries share the destination's raw read cache. */
export const SETTINGS_VIEWS = [
  { to: "/settings/company-domain", label: "shell.settings.domain", summary: { ...get(readPath("/settings/company-domain")), format: "domain" } },
  { to: "/people/numbering", label: "identifiers.numbering.title", summary: { ...get(readPath("/people/numbering")), format: "numbering" } },
  { to: "/people/job-titles", label: "shell.settings.titles", summary: { ...get(readPath("/people/job-titles")), format: "titles" } },
  { to: "/people/period-locks", label: "periodLocks.title", summary: { ...get(readPath("/people/period-locks"), { params: { query: { limit: 200 } } }), format: "periods" } },
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
