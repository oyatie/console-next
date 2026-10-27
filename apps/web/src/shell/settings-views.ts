// SPDX-License-Identifier: LicenseRef-Proprietary
import type { StaticDataRouteOption } from "@tanstack/react-router";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal, type AccessRequirement } from "../reference/authz/domain/access";

/** Existing settings destinations; route metadata owns every access requirement. NAV-SHELL can consume this list. */
export const SETTINGS_VIEWS = [
  { to: "/settings/company-domain", label: "shell.settings.domain" },
  { to: "/people/numbering", label: "identifiers.numbering.title" },
  { to: "/people/job-titles", label: "shell.settings.titles" },
  { to: "/people/period-locks", label: "periodLocks.title" },
] as const;
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
